"""PlanBranch: local planning, with scanner evidence kept separate from intent."""

__version__ = "0.2.0"


def create_app(*args, **kwargs):
    from .app import create_app as factory
    return factory(*args, **kwargs)
