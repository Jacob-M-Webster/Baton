"""Set up and check Stripe billing for Baton (test mode by default).

    python scripts/stripe_setup.py plan                    # the Team and Enterprise per-seat prices, and the customer portal
    python scripts/stripe_setup.py webhook https://HOST    # register HOST/api/billing/webhook, print its signing secret
    python scripts/stripe_setup.py renewal                 # prove it recurs: subscribe a test card, skip ahead a month

Reads STRIPE_SECRET_KEY from the environment or .env. Refuses live keys unless --live is passed.
`renewal` uses a Stripe test clock and Stripe's test Visa (pm_card_visa, the API form of 4242 4242 4242 4242):
it subscribes a throwaway customer, moves the clock forward a month, shows the second invoice being paid,
then deletes the clock (and the customer with it).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from baton.billing import Billing, _get  # noqa: E402
from baton.config import load_settings  # noqa: E402

WEBHOOK_EVENTS = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
]


def billing_for(args) -> Billing:
    settings = load_settings()
    key = settings.stripe_secret_key
    if not key:
        sys.exit("Set STRIPE_SECRET_KEY (a test key, sk_test_...) in the environment or .env first.")
    if key.startswith(("sk_live_", "rk_live_")) and not args.live:
        sys.exit("That's a live key. Pass --live if you really mean to change your live Stripe account.")
    return Billing(settings, db=None)


async def plan(b: Billing) -> None:
    for key, p in b.plans.items():
        price = await b.price_id(key)
        print(f"Plan ready: {p['name']}, {p['seat'] / 100:.2f} {b.settings.plan_currency.upper()} per seat per month, "
              f"billed {'annually' if p['interval'] == 'year' else 'monthly'}, at least {p['min_seats']} seat(s) (price {price})")
    await b._ensure_portal()
    print("Customer portal configured.")


async def webhook(b: Billing, base: str) -> None:
    url = base.rstrip("/") + "/api/billing/webhook"
    existing = await b.client.v1.webhook_endpoints.list_async({"limit": 100})
    for ep in _get(existing, "data", []):
        if _get(ep, "url") == url:
            print(f"A webhook for {url} already exists ({_get(ep, 'id')}). Stripe only shows its secret when it's")
            print("created: copy it from the dashboard, or delete the endpoint there and run this again.")
            return
    ep = await b.client.v1.webhook_endpoints.create_async({
        "url": url, "enabled_events": WEBHOOK_EVENTS, "description": "Baton workspace billing",
    })
    print(f"Webhook created for {url}")
    print(f"Add this to the server's settings (deploy/lightsail/server.env), then deploy:\n\n  STRIPE_WEBHOOK_SECRET={_get(ep, 'secret')}\n")


async def renewal(b: Billing) -> None:
    c = b.client.v1
    price = await b.price_id()
    start = int(time.time())
    clock = await c.test_helpers.test_clocks.create_async({"frozen_time": start, "name": "Baton renewal check"})
    try:
        customer = await c.customers.create_async({"email": "renewal-check@example.com", "test_clock": _get(clock, "id"),
                                                   "name": "Baton renewal check"})
        pm = await c.payment_methods.attach_async("pm_card_visa", {"customer": _get(customer, "id")})
        await c.customers.update_async(_get(customer, "id"), {"invoice_settings": {"default_payment_method": _get(pm, "id")}})
        sub = await c.subscriptions.create_async({"customer": _get(customer, "id"), "items": [{"price": price}],
                                                  "metadata": {"baton_workspace": "renewal-check"}})
        print(f"Subscribed a test customer with Stripe's test Visa (4242 4242 4242 4242): {_get(sub, 'id')} is {_get(sub, 'status')}")

        await c.test_helpers.test_clocks.advance_async(_get(clock, "id"), {"frozen_time": start + 32 * 86400})
        print("Moving the test clock forward 32 days...", end="", flush=True)
        for _ in range(90):
            if _get(await c.test_helpers.test_clocks.retrieve_async(_get(clock, "id")), "status") == "ready":
                break
            print(".", end="", flush=True)
            await asyncio.sleep(2)
        print()
        invoices = await c.invoices.list_async({"customer": _get(customer, "id"), "limit": 10})
        rows = sorted(_get(invoices, "data", []), key=lambda i: _get(i, "created", 0))
        for inv in rows:
            print(f"  invoice {_get(inv, 'number') or _get(inv, 'id')}: {_get(inv, 'amount_paid', 0) / 100:.2f} "
                  f"{str(_get(inv, 'currency', '')).upper()}, {_get(inv, 'status')} ({_get(inv, 'billing_reason')})")
        paid = [i for i in rows if _get(i, "status") == "paid"]
        if len(paid) >= 2:
            print(f"Recurring billing works: {len(paid)} paid invoices, the first at signup and one at renewal.")
        else:
            sys.exit("Expected a paid signup invoice and a paid renewal invoice. Check the Stripe dashboard.")
    finally:
        await c.test_helpers.test_clocks.delete_async(_get(clock, "id"))
        print("Cleaned up the test clock and its customer.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["plan", "webhook", "renewal"])
    ap.add_argument("url", nargs="?", help="for `webhook`: the server's public base URL")
    ap.add_argument("--live", action="store_true", help="allow a live key")
    args = ap.parse_args()
    b = billing_for(args)
    if args.command == "plan":
        asyncio.run(plan(b))
    elif args.command == "webhook":
        if not args.url:
            sys.exit("usage: stripe_setup.py webhook https://your-baton-host")
        asyncio.run(webhook(b, args.url))
    else:
        asyncio.run(renewal(b))


if __name__ == "__main__":
    main()
