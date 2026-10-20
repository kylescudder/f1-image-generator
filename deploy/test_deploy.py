"""Security gates, queue handling and rollback without production changes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployer', Path(__file__).with_name('herman-deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MIGRATE = module.migrate  # setUp replaces module.migrate with a mock
D = 'sha256:' + 'a' * 64
R = 'b' * 40


def docker_inspect(image, state, labels=None):
    # Shaped like `docker inspect <container>`: a one-element array of the full document.
    return json.dumps([{'Id':'container','Config':{'Image':image,'Labels':labels,'Env':['UNUSED=1']},'State':state}]).encode()


class Deploy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Path(self.temp.name)
        self.patches = [patch.object(module, k, self.app / v) for k,v in
                        [('APP','.'),('STATE','state'),('BACKUPS','backups'),('REQUESTS','requests')]]
        for p in self.patches:p.start()
        for d in (module.STATE,module.BACKUPS,module.REQUESTS):d.mkdir()
        for f in ('.env',):
            p=self.app/f;p.write_text('PADDOCK_IMAGE=previous\n');p.chmod(0o600)
        self.calls=[]
        self.backup = patch.object(module, 'backup_database').start()
        self.migrate = patch.object(module, 'migrate').start()
        self.acceptance = patch.object(module, 'verify').start()

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        patch.stopall()
        self.temp.cleanup()

    def queue(self, name, timestamp, digest=D):
        (module.REQUESTS/name).write_text(json.dumps({'digest':digest,'revision':R,'timestamp':timestamp}))

    def test_newest_valid_request_wins_and_malformed_is_consumed(self):
        self.queue('old.json',10)
        self.queue('new.json',20,'sha256:'+'c'*64)
        (module.REQUESTS/'broken.json').write_text('{')
        self.assertEqual(module.take_request()['timestamp'],20)
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertIsNone(module.take_request())

    def test_symlink_cannot_read_outside_queue(self):
        private=self.app/'private';private.write_text('keep')
        (module.REQUESTS/'link.json').symlink_to(private)
        self.assertIsNone(module.take_request())
        self.assertEqual(private.read_text(),'keep')

    def test_replaced_queue_directory_is_rejected_without_touching_target(self):
        module.REQUESTS.rmdir()
        target=self.app/'other';target.mkdir()
        (target/'private.json').write_text('keep')
        module.REQUESTS.symlink_to(target)
        with self.assertRaises(module.Error):module.take_request()
        self.assertEqual((target/'private.json').read_text(),'keep')

    def test_malformed_directory_is_quarantined_without_a_launch_loop(self):
        (module.REQUESTS/'bad.json').mkdir()
        self.assertIsNone(module.take_request())
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertEqual(len(list(module.STATE.glob('rejected-directory-*'))),1)

    def test_stale_partial_is_removed_and_fresh_partial_is_left_alone(self):
        stale=module.REQUESTS/'.old.json.tmp';stale.write_text('partial');os.utime(stale,(0,0))
        fresh=module.REQUESTS/'.new.json.tmp';fresh.write_text('partial')
        self.assertIsNone(module.take_request())
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_healthy_same_digest_requires_the_requested_revision(self):
        current={'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                 'State':{'Running':True,'Health':{'Status':'healthy'}}}
        raw = docker_inspect(current['Config']['Image'],current['State'],current['Config']['Labels'])
        with patch.object(module,'run',return_value=raw),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            module.deploy(D,R)
            start.assert_not_called()

    def fake_run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2]==['docker','inspect']:
            return docker_inspect('previous',{'Running':True,'Health':{'Status':'healthy'}},{})
        if args[:3]==['docker','image','inspect']:
            return json.dumps({'org.opencontainers.image.revision':R}).encode()
        return b''

    def fake_compose(self,*args,**kwargs):
        if args[0]=='ps':return b'container\n'
        if args[0]=='exec' and kwargs.get('output'):kwargs['output'].write(b'PGDMP'+b'0'*1024)
        return b''

    def test_failed_verification_never_migrates_or_starts(self):
        def run(args,**kwargs):
            if args[0]=='gh':raise module.Error('verification rejected')
            return self.fake_run(args,**kwargs)
        with patch.object(module,'run',run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            start.assert_not_called()
        self.backup.assert_not_called()
        self.migrate.assert_not_called()

    def test_revision_mismatch_never_migrates_or_starts(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            start.assert_not_called()
        self.backup.assert_not_called()

    def test_failed_health_restores_previous_and_does_not_record_success(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',side_effect=[module.Error('unhealthy'),None]) as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D,'previous'])
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('PADDOCK_IMAGE=previous',(self.app/'.env').read_text())

    def test_failed_migration_keeps_the_previous_image_and_does_not_start(self):
        self.migrate.side_effect = module.Error('migration rejected')
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            start.assert_not_called()
        self.backup.assert_called_once()
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('PADDOCK_IMAGE=previous',(self.app/'.env').read_text())

    def test_failed_backup_keeps_the_previous_image_and_does_not_start(self):
        self.backup.side_effect = module.Error('backup rejected')
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            start.assert_not_called()
        self.migrate.assert_not_called()
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('PADDOCK_IMAGE=previous',(self.app/'.env').read_text())

    def test_success_is_pinned_and_new_arrival_remains_queued(self):
        def start(image):self.queue('arriving.json',30)
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',start):module.deploy(D,R)
        verify = next(c for c in self.calls if c[:3] == ['gh', 'attestation', 'verify'])
        self.assertIn('--bundle-from-oci', verify)
        self.assertIn('--deny-self-hosted-runners', verify)
        self.assertEqual(verify[verify.index('--source-digest') + 1], R)
        self.assertEqual(verify[verify.index('--source-ref') + 1], 'refs/heads/main')
        self.assertIn(module.IMAGE+'@'+D,(self.app/'.env').read_text())
        self.assertTrue((module.STATE/'history.log').exists())
        self.assertTrue((module.REQUESTS/'arriving.json').exists())
        self.assertEqual(json.loads((module.STATE/'public/deployment.json').read_text()),
                         {'revision':R,'image':module.IMAGE+'@'+D})

    def test_failed_acceptance_restores_previous_without_acknowledging_candidate(self):
        previous={'revision':'c'*40,'image':module.IMAGE+'@sha256:'+'d'*64}
        (module.STATE/'public').mkdir()
        module.save_json(module.STATE/'public/deployment.json',previous)
        self.acceptance.side_effect=module.Error('API acceptance failed')
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D,'previous'])
        self.assertFalse((module.STATE/'deployment.json').exists())
        self.assertEqual(json.loads((module.STATE/'public/deployment.json').read_text()),previous)
        self.assertIn('PADDOCK_IMAGE=previous',(self.app/'.env').read_text())

    def test_healthy_same_digest_rechecks_acceptance_before_acknowledging(self):
        current={'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                 'State':{'Health':{'Status':'healthy'}}}
        self.acceptance.side_effect=module.Error('database unavailable')
        with patch.object(module,'inspect_current',return_value=current),patch.object(module,'compose',self.fake_compose):
            with self.assertRaises(module.Error):module.deploy(D,R)
        self.assertFalse((module.STATE/'public/deployment.json').exists())

    def test_migration_container_bypasses_the_app_entrypoint(self):
        # The image entrypoint writes to /app/data and ignores its arguments (it would start the server),
        # so the read-only one-shot migration container must run bun directly.
        platform=self.app/'platform'
        secret=platform/'projects/paddock/owner-password'
        secret.parent.mkdir(parents=True);secret.write_text('x');secret.chmod(0o600)
        with patch.object(module,'APP',platform/'apps/paddock'),patch.object(module,'run') as run:
            MIGRATE(module.IMAGE+'@'+D)
        command=run.call_args.args[0]
        self.assertEqual(command[command.index('--entrypoint')+1],'bun')
        self.assertEqual(command[-2:],[module.IMAGE+'@'+D,'/app/server/migrate.ts'])

    def test_first_deploy_lists_containers_with_the_candidate_image(self):
        # compose.yaml requires PADDOCK_IMAGE, which is unset on a first deploy.
        calls=[]
        def compose(*args,**kwargs):
            calls.append((args,kwargs.get('image')))
            raise module.Error('stop after the first call')
        with patch.object(module,'compose',compose),self.assertRaises(module.Error):module.deploy(D,R)
        self.assertEqual(calls[0],(('ps','-a','-q','web'),module.IMAGE+'@'+D))

    def test_inspect_survives_pipes_and_newlines_in_a_failed_health_log(self):
        log=[{'ExitCode':1,'Output':'error: boom\n3 | for (const path of paths) {\n  ^\n'},{'ExitCode':1,'Output':'a|b|c\n|\n'}]
        raw=docker_inspect(module.IMAGE+'@'+D,{'Status':'exited','Running':False,'Health':{'Status':'unhealthy','Log':log}},
                           {'org.opencontainers.image.revision':R})
        with patch.object(module,'run',return_value=raw):current=module.inspect_current('container')
        self.assertEqual(current,{'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                                  'State':{'Running':False,'Status':'exited','Health':{'Status':'unhealthy'}}})

    def test_unparseable_inspect_output_is_reported_without_echoing_it(self):
        with patch.object(module,'run',return_value=b'3 | secret-looking text'):
            with self.assertRaises(module.Error) as caught:module.inspect_current('container')
        self.assertNotIn('secret',str(caught.exception))

    def test_stopped_failed_candidate_is_replaced_and_never_restored(self):
        log=[{'ExitCode':1,'Output':'3 | for (const path of paths) {\n'}]
        stopped=docker_inspect(module.IMAGE+'@sha256:'+'c'*64,{'Status':'exited','Running':False,
                               'Health':{'Status':'unhealthy','Log':log}},{})
        def run(args,**kwargs):
            if args[:2]==['docker','inspect']:return stopped
            return self.fake_run(args,**kwargs)
        stops=[]
        def compose(*args,**kwargs):
            if args[0]=='stop':stops.append(kwargs.get('image'))
            return self.fake_compose(*args,**kwargs)
        with patch.object(module,'run',run),patch.object(module,'compose',compose),patch.object(module,'start',side_effect=module.Error('unhealthy')) as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D])
        self.assertEqual(stops,[module.IMAGE+'@'+D])
        with patch.object(module,'run',run),patch.object(module,'compose',compose),patch.object(module,'start') as start:
            module.deploy(D,R)
            start.assert_called_once_with(module.IMAGE+'@'+D)
        self.assertIn('PADDOCK_IMAGE='+module.IMAGE+'@'+D,(self.app/'.env').read_text())


if __name__=='__main__':unittest.main()
