"""Removable source example for FlowDesk. The scanner does not execute this file."""
from decimal import Decimal as Money

order_count: int = 0


def validate_order(items: list[str]) -> bool:
    count: int = len(items)
    return count > 0


def process_orders(orders: list[list[str]]) -> list[bool]:
    global order_count
    count = 0
    results: list[bool] = []

    def record_result(accepted: bool):
        nonlocal count
        count += 1
        results.append(accepted)

    for order in orders:
        if validate_order(order):
            record_result(True)
            order_count += 1
        else:
            record_result(False)
    return results


class OrderQueue:
    capacity: int = 20

    def __init__(self):
        self.pending: list[str] = []
