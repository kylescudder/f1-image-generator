#!/usr/bin/env python3
"""Deploy independently verified main images, consuming the newest queued request."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

IMAGE = 'ghcr.io/kylescudder/f1-image-generator'
REPO = 'kylescudder/f1-image-generator'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
APP = Path(os.environ.get('APP_DIR', Path(__file__).resolve().parents[1]))
STATE = APP / 'state'
BACKUPS = APP / 'backups'
REQUESTS = APP / 'deploy-spool/requests'


class Error(RuntimeError):
    pass


def log(message):
    print(f'[paddock-deploy] {datetime.now(timezone.utc).isoformat()} {message}', flush=True)


def run(args, *, output=None, input_data=None, env=None, timeout=300):
    try:
        result = subprocess.run(args, cwd=APP, input=input_data, env=env,
                                stdout=output if output is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Error(f'{args[0]} operation timed out.') from None
    if result.returncode:
        # Command stderr and resolved environment can contain production credentials.
        raise Error(f'{args[0]} {args[1]} operation failed (exit {result.returncode}).')
    return result.stdout or b''


def compose(*args, image=None, output=None):
    env = os.environ.copy()
    if image:
        env['PADDOCK_IMAGE'] = image
    return run(['docker', 'compose', '--project-directory', str(APP), '-f', str(APP / 'compose.yaml'),
                '--env-file', str(APP / '.env'), *args], env=env, output=output, timeout=180)


def private_env(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Error(f'{path.name} must be a protected regular file (0600).')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise Error(f'{path.name} contains an invalid environment entry.')
        values[key] = value.strip().strip('"\'')
    return values


def save_json(path, value):
    temp = path.with_name(path.name + '.next')
    with temp.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(0o600)
    temp.replace(path)


def take_request():
    # Consume this snapshot only. Arrivals during deployment start the next run.
    if REQUESTS.is_symlink() or REQUESTS.parent.is_symlink():
        raise Error('Queue directories must not be symlinks.')
    # A receiver crash can leave a partial file. Remove old partials so launchd
    # does not keep restarting on a nonempty directory with no ready requests.
    for partial in REQUESTS.glob('.*.json.tmp'):
        if not partial.is_symlink() and partial.is_file() and time.time() - partial.stat().st_mtime > 30:
            partial.unlink()
    paths = sorted(REQUESTS.glob('*.json'))
    if not paths:
        return None
    valid = []
    for path in paths:
        try:
            if path.is_symlink() or path.stat().st_size > 1024:
                raise ValueError()
            value = json.loads(path.read_text())
            if not DIGEST.fullmatch(value.get('digest', '')) or not REVISION.fullmatch(value.get('revision', '')):
                raise ValueError()
            if type(value.get('timestamp')) is not int:
                raise ValueError()
            valid.append((value['timestamp'], path.name, value))
        except (ValueError, TypeError, OSError, AttributeError):
            log('discarded malformed queue entry')
    selected = max(valid, key=lambda entry:entry[:2])[2] if valid else None
    if selected:
        save_json(STATE / 'last-request.json', selected)
    for path in paths:
        if path.is_dir() and not path.is_symlink():
            path.rename(STATE / ('rejected-directory-' + uuid.uuid4().hex))
        else:
            path.unlink(missing_ok=True)
    return selected


def pin(image):
    path = APP / '.env'
    lines = [line for line in path.read_text().splitlines() if not line.startswith('PADDOCK_IMAGE=')]
    temp = path.with_name('.env.next')
    temp.write_text('\n'.join(lines) + f'\nPADDOCK_IMAGE={image}\n')
    temp.chmod(0o600)
    temp.replace(path)


def start(image):
    compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'web', image=image)
    compose('exec', '-T', 'web', 'node', '-e',
            "fetch('http://127.0.0.1:3000/api/health').then(async r=>{if(!r.ok || !(await r.json()).ok) process.exit(1)}).catch(()=>process.exit(1))", image=image)


def inspect_current(container):
    raw = run(['docker', 'inspect', '--format',
               '{{json .Config.Image}}|{{json .State}}|{{json .Config.Labels}}', container])
    image, state, labels = [json.loads(part) for part in raw.decode().strip().split('|', 2)]
    return {'Config': {'Image': image, 'Labels': labels}, 'State': state}


def backup_data():
    # SQLite's online backup is made inside the running container, so its WAL
    # is read consistently through the same filesystem implementation.
    ids = compose('ps', '-q', 'web').decode().strip().splitlines()
    if not ids:
        log('first deployment; no running database to back up')
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = BACKUPS / f'pre-deploy-{stamp}.sqlite'
    partial = target.with_suffix('.sqlite.partial')
    script = (
        "const {DatabaseSync}=require('node:sqlite');"
        "const fs=require('node:fs');"
        "const target='/tmp/paddock-deploy-backup.sqlite';"
        "try{fs.unlinkSync(target)}catch{};"
        "const db=new DatabaseSync('/app/data/paddock.sqlite');"
        "db.exec(\"PRAGMA busy_timeout=10000; VACUUM INTO '/tmp/paddock-deploy-backup.sqlite'\");"
        "db.close();process.stdout.write(fs.readFileSync(target));fs.unlinkSync(target);"
    )
    with partial.open('wb') as stream:
        compose('exec', '-T', 'web', 'node', '-e', script, output=stream)
    if partial.stat().st_size < 512 or partial.read_bytes()[:16] != b'SQLite format 3\0':
        raise Error('Pre-deploy database backup was invalid.')
    partial.replace(target)
    for old in sorted(BACKUPS.glob('pre-deploy-*.sqlite'), reverse=True)[14:]:
        old.unlink()
    log('saved pre-deploy artwork library database backup')


def deploy(digest, requested_revision=None):
    if not DIGEST.fullmatch(digest):
        raise Error('Use an exact sha256 digest.')
    runtime = private_env(APP / '.env')
    candidate = f'{IMAGE}@{digest}'
    ids = compose('ps', '-a', '-q', 'web').decode().strip().splitlines()
    if len(ids) > 1:
        raise Error('Expected a single Paddock container.')
    current = inspect_current(ids[0]) if ids else None
    running = current['Config']['Image'] if current else None
    if running == candidate and current['State'].get('Health', {}).get('Status') == 'healthy':
        revision = (current['Config'].get('Labels') or {}).get('org.opencontainers.image.revision', '')
        if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
            raise Error('Running image revision does not match the request.')
        log('requested digest is already healthy')
        pin(candidate)
        return
    log(f'verifying {candidate}')
    verify = ['gh', 'attestation', 'verify', f'oci://{candidate}', '--bundle-from-oci', '--repo', REPO,
         '--signer-workflow', REPO + '/.github/workflows/release.yml', '--source-ref', 'refs/heads/main',
         '--deny-self-hosted-runners']
    if requested_revision:
        verify.extend(['--source-digest', requested_revision])
    run(verify, timeout=180)
    run(['docker', 'pull', '--quiet', candidate], timeout=300)
    labels = json.loads(run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', candidate])) or {}
    revision = labels.get('org.opencontainers.image.revision', '')
    if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
        raise Error('Verified image revision does not match the request.')
    log(f'provenance verified for {revision}')
    backup_data()
    log('database backed up; additive schema is initialized by the runtime')
    try:
        start(candidate)
    except Error:
        log('candidate failed health check')
        if running and running != candidate:
            try:
                start(running)
                pin(running)
                log('previous image restored; compatible SQLite data preserved')
            except Error:
                raise Error('ROLLBACK FAILED; inspect the private deployment logs.') from None
        else:
            compose('stop', 'web', image=candidate)
        raise Error('Candidate was not healthy; deploy failed.') from None
    pin(candidate)
    stamp = datetime.now(timezone.utc).isoformat()
    with (STATE / 'history.log').open('a') as stream:
        stream.write(f'{stamp} {candidate} {revision}\n')
    save_json(STATE / 'deployment.json', {'deployed_at':stamp, 'image':candidate,
              'revision':revision, 'previous_image':running})
    log(f'healthy on {candidate}')


def main():
    os.umask(0o077)
    for folder in (STATE, BACKUPS, REQUESTS):
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(sys.argv) > 2:
            raise Error('Usage: herman-deploy.sh [sha256:<digest>]')
        request = {'digest':sys.argv[1]} if len(sys.argv) == 2 else take_request()
        if request is None:
            log('no queued requests')
            return
        try:
            deploy(request['digest'], request.get('revision'))
        except Error as error:
            save_json(STATE / 'last-failure.json', {'failed_at':datetime.now(timezone.utc).isoformat(),
                      'digest':request['digest'], 'error':str(error)})
            raise


if __name__ == '__main__':
    try:
        main()
    except (Error, OSError, ValueError, KeyError) as error:
        log(str(error) if isinstance(error, Error) else f'Deploy failed: {type(error).__name__}.')
        sys.exit(1)
