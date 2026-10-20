#!/usr/bin/env python3
"""Prepare the app-specific host pieces. Cloudflare Access is provisioned first.

Run from the reviewed checkout on the host, as the Colima owner, passing the host's
LocalHostName: python3 -B deploy/bootstrap-host.py <LocalHostName>. No credentials
are read or printed by this script; it creates a local webhook secret only.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

APP = Path(__file__).resolve().parents[1]
PLATFORM = Path('/Users/kyle/platform')

def main():
    host = sys.argv[1] if len(sys.argv) == 2 else None
    if not host or subprocess.check_output(['/usr/sbin/scutil', '--get', 'LocalHostName']).decode().strip() != host:
        raise SystemExit('Run this on the host as the Colima owner: bootstrap-host.py <LocalHostName>.')
    if APP != PLATFORM / 'apps/paddock':
        raise SystemExit('Use the reviewed checkout at /Users/kyle/platform/apps/paddock.')
    os.umask(0o077)
    for name in ('state', 'backups', 'data', 'secrets', 'deploy-spool/requests'):
        (APP / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    secret = APP / 'secrets/deploy-webhook-secret'
    if not secret.exists():
        secret.write_text(secrets.token_hex(32) + '\n')
        secret.chmod(0o600)
    runtime = APP / '.env'
    if not runtime.exists():
        runtime.write_text('APP_URL=https://paddock.thescudders.org\nPADDOCK_DATA_DIR=./data\nCLERK_PUBLISHABLE_KEY=\nCLERK_SECRET_KEY=\nOPENROUTER_API_KEY=\nEMBY_URL=\nEMBY_API_KEY=\n')
        runtime.chmod(0o600)
    hook = APP / '.env.deploy-hook'
    if not hook.exists():
        hook.write_text(f'DEPLOY_HOOK_USER={os.getuid()}:{os.getgid()}\nDEPLOY_SPOOL_DIR={APP}/deploy-spool\nDEPLOY_WEBHOOK_SECRET_FILE={secret}\nPLATFORM_WEB_NETWORK=platform-web\n')
        hook.chmod(0o600)
    subprocess.run(['gh', 'api', '--method', 'PUT', 'repos/kylescudder/paddock/environments/production', '--input', '-'], input=json.dumps({'deployment_branch_policy': {'protected_branches': False, 'custom_branch_policies': True}}).encode(), stdout=subprocess.DEVNULL, check=True)
    policies = json.loads(subprocess.check_output(['gh', 'api', 'repos/kylescudder/paddock/environments/production/deployment-branch-policies']))
    if not any(item['name'] == 'main' for item in policies.get('branch_policies', [])):
        subprocess.run(['gh', 'api', '--method', 'POST', 'repos/kylescudder/paddock/environments/production/deployment-branch-policies', '-f', 'name=main', '-f', 'type=branch'], stdout=subprocess.DEVNULL, check=True)
    with secret.open('rb') as stream:
        subprocess.run(['gh', 'secret', 'set', 'DEPLOY_WEBHOOK_SECRET', '--repo', 'kylescudder/paddock', '--env', 'production'], stdin=stream, check=True)
    subprocess.run(['docker', 'compose', '-f', 'deploy/compose.deploy-hook.yaml', '--env-file', '.env.deploy-hook', 'up', '-d', '--wait'], cwd=APP, check=True)
    print('Register this app in /Users/kyle/platform/deploy-core/apps.json before enabling releases.')
    print('Host receiver, protected runtime template, and signing secret are prepared.')
    print('Complete the Cloudflare Access/hostname steps in deploy/README.md before enabling DEPLOY_ENABLED.')

if __name__ == '__main__':
    main()
