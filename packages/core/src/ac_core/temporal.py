from temporalio.client import Client

from ac_core.settings import Settings

DEFAULT_TASK_QUEUE = "ac-default"


async def connect(settings: Settings) -> Client:
    return await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)
