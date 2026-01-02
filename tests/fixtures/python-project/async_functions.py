# Async functions
import asyncio

async def async_function():
    """Async function"""
    await asyncio.sleep(1)
    result = await helper()
    return result

async def helper():
    """Async helper"""
    return "done"

def sync_function():
    """Regular sync function"""
    return "sync"

class AsyncClass:
    async def async_method(self):
        """Async method"""
        await asyncio.sleep(0.1)
        return "async result"
