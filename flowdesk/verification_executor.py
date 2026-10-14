"""One explicitly selected local check, without a provider or editing tools."""
from .command_runner import DockerCommandRunner


class VerificationExecutor:
    def __init__(self, data_dir, runner=None):
        self.runner = runner or DockerCommandRunner(data_dir)

    def status(self, provider=None):
        return {'available': True}

    def configure(self, selection):
        policy = self.runner.configure()
        if not policy.get('available'):
            raise RuntimeError(policy.get('reason', 'The local verification runtime is unavailable.'))
        return {'provider': 'verification', 'commandPolicy': policy,
                'command': selection['command'], 'timeoutSeconds': selection['timeoutSeconds']}

    def run(self, context, worktree, cancel, on_event):
        generation = context['generation']
        result = self.runner.verify({**generation['commandPolicy'], 'evidenceRunId': context['runId'], 'candidateHash': generation['candidateHash']},
            worktree, {key: generation[key] for key in ('command', 'timeoutSeconds')},
            'verification', cancel, on_event)
        command = result.get('command')
        status = command.get('status') if command else 'failed'
        return {'status': 'succeeded' if status == 'completed' else 'cancelled' if cancel.is_set() else 'failed',
                'summary': 'Verification without editing finished. Review the command observation and its coverage.',
                'commands': [command] if command else []}
