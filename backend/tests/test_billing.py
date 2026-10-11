"""Stripe billing: a flat monthly plan per workspace, against a fake Stripe client (webhook signatures are real)."""
import hashlib
import hmac
import json
import time
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from baton.app import create_app
from baton.billing import Billing, BillingError
from baton.config import load_settings
from baton.sessions import PaymentRequired

WEBHOOK_SECRET = "whsec_test_secret"


class FakeStripe:
    """Just enough of StripeClient.v1 for billing.py, recording every call."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.prices: list[dict] = []
        self.subscriptions: dict[str, dict] = {}
        self.checkouts: dict[str, dict] = {}
        self.portal_configs: list[dict] = []

        def svc(**methods):
            return NS(**{k: self._rec(k, v) for k, v in methods.items()})

        self.v1 = NS(
            prices=svc(list_async=self._list_prices, create_async=self._create_price),
            products=svc(create_async=lambda p: {"id": "prod_1", **p}),
            checkout=NS(sessions=svc(create_async=self._create_checkout, retrieve_async=self._get_checkout)),
            subscriptions=svc(retrieve_async=lambda sid, *a: self.subscriptions[sid]),
            billing_portal=NS(
                configurations=svc(list_async=lambda p: {"data": self.portal_configs},
                                   create_async=lambda p: self.portal_configs.append(p) or {"id": "bpc_1"}),
                sessions=svc(create_async=lambda p: {"url": f"https://billing.stripe.test/p/{p['customer']}"}),
            ),
        )

    def _rec(self, name, fn):
        async def call(*args):
            self.calls.append((name, args[0] if args else {}))
            return fn(*args)
        return call

    def _list_prices(self, p):
        return {"data": [x for x in self.prices if x["lookup_key"] in p["lookup_keys"]]}

    def _create_price(self, p):
        price = {"id": f"price_{len(self.prices) + 1}", **p}
        self.prices.append(price)
        return price

    def _create_checkout(self, p):
        cs = {"id": f"cs_test_{len(self.checkouts) + 1}", "url": "https://checkout.stripe.test/c/pay", **p}
        self.checkouts[cs["id"]] = cs
        return cs

    def _get_checkout(self, sid, params=None):
        return self.checkouts[sid]

    def complete_checkout(self, cs_id, status="active", workspace=None):
        """What Stripe does once the test card goes through: a subscription exists and the session points at it."""
        cs = self.checkouts[cs_id]
        sub = {
            "id": "sub_1", "customer": "cus_1", "status": status, "cancel_at_period_end": False,
            "metadata": {"baton_workspace": workspace or cs["subscription_data"]["metadata"]["baton_workspace"]},
            "items": {"data": [{"current_period_end": 1_900_000_000}]},
        }
        self.subscriptions["sub_1"] = sub
        cs.update(subscription=sub, customer_details={"email": "team@example.com"})
        return sub


def signed(payload: dict, secret: str = WEBHOOK_SECRET) -> tuple[bytes, str]:
    body = json.dumps(payload).encode()
    t = int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return body, f"t={t},v1={sig}"


@pytest.fixture
def billing(tmp_path, mgr):
    mgr.settings.stripe_webhook_secret = WEBHOOK_SECRET
    mgr.settings.billing_required = True
    mgr.billing = Billing(mgr.settings, mgr.db, client=FakeStripe())
    return mgr.billing


def test_billing_is_off_without_a_stripe_key(mgr):
    assert not mgr.billing.enabled and mgr.billing.allows("anthropic")
    assert mgr.billing.view()["enabled"] is False


async def test_paid_models_need_a_subscription_and_the_demo_stays_free(mgr, billing):
    assert billing.required and not billing.allows("anthropic") and billing.allows("demo")
    with pytest.raises(PaymentRequired, match="Baton Team"):
        mgr.create_session(user_id="u_alice", task="t", provider="anthropic", model="claude-sonnet-5-5")
    s = mgr.create_session(user_id="u_alice", task="Add rate limiting", provider="demo", model="baton-demo")
    # Switching an existing session to a paid model is gated too.
    with pytest.raises(PaymentRequired):
        await mgr.command(s["id"], "u_alice", {"type": "set_model", "provider": "anthropic", "model": "claude-sonnet-5-5"})


async def test_checkout_creates_the_plan_once_and_returning_from_it_activates(mgr, billing):
    stripe = billing.client
    url = await billing.checkout("https://baton.test")
    assert url.startswith("https://checkout.stripe.test/")
    price = stripe.prices[0]
    assert price["unit_amount"] == 2900 and price["recurring"] == {"interval": "month"} and price["lookup_key"] == "baton_team_monthly"
    cs = next(iter(stripe.checkouts.values()))
    assert cs["mode"] == "subscription" and cs["line_items"] == [{"price": price["id"], "quantity": 1}]
    assert cs["success_url"] == "https://baton.test/billing?checkout={CHECKOUT_SESSION_ID}"
    assert cs["client_reference_id"] == billing.workspace

    stripe.complete_checkout(cs["id"])
    await billing.sync_checkout(cs["id"])
    v = billing.view()
    assert v["active"] and v["status"] == "active" and v["email"] == "team@example.com"
    assert v["current_period_end"] == 1_900_000_000
    assert billing.allows("anthropic")
    mgr.create_session(user_id="u_alice", task="t", provider="anthropic", model="claude-sonnet-5-5")

    # A new process finds the price by its lookup key instead of creating another.
    again = Billing(mgr.settings, mgr.db, client=stripe)
    assert await again.price_id() == price["id"] and len(stripe.prices) == 1
    with pytest.raises(BillingError, match="already has an active"):
        await billing.checkout("https://baton.test")

    url = await billing.portal("https://baton.test")
    assert url.endswith("/cus_1") and stripe.portal_configs  # the portal got a default configuration


async def test_other_workspaces_subscriptions_are_ignored(billing):
    stripe = billing.client
    await billing.checkout("https://baton.test")
    cs_id = next(iter(stripe.checkouts))
    stripe.complete_checkout(cs_id, workspace="ws_someone_else")
    await billing.sync_checkout(cs_id)
    assert not billing.view()["active"]


async def test_webhooks_are_verified_and_refetch_the_subscription(billing):
    stripe = billing.client
    await billing.checkout("https://baton.test")
    cs_id = next(iter(stripe.checkouts))
    stripe.complete_checkout(cs_id)

    body, sig = signed({"id": "evt_1", "object": "event", "type": "checkout.session.completed",
                        "data": {"object": {"id": cs_id, "object": "checkout.session", "mode": "subscription",
                                            "client_reference_id": billing.workspace}}})
    assert await billing.webhook(body, sig) == "checkout.session.completed"
    assert billing.view()["active"]

    # The customer cancels in the portal; the event body says little, the refetched subscription says "canceled".
    stripe.subscriptions["sub_1"]["status"] = "canceled"
    body, sig = signed({"id": "evt_2", "object": "event", "type": "customer.subscription.deleted",
                        "data": {"object": {"id": "sub_1", "object": "subscription"}}})
    await billing.webhook(body, sig)
    assert not billing.view()["active"] and not billing.allows("gemini")

    # A renewal that fails puts the team in the grace period: still working, flagged past_due.
    stripe.subscriptions["sub_1"]["status"] = "past_due"
    body, sig = signed({"id": "evt_3", "object": "event", "type": "invoice.payment_failed",
                        "data": {"object": {"id": "in_1", "object": "invoice",
                                            "parent": {"subscription_details": {"subscription": "sub_1"}}}}})
    await billing.webhook(body, sig)
    assert billing.view()["status"] == "past_due" and billing.allows("gemini")

    forged, _ = signed({"type": "customer.subscription.updated"}, secret="whsec_wrong")
    with pytest.raises(BillingError, match="Invalid webhook"):
        await billing.webhook(forged, sig)


def test_api_returns_402_and_lets_stripe_reach_the_webhook_past_the_access_code(tmp_path):
    settings = load_settings(data_dir=tmp_path, access_code="code-1", stripe_secret_key="sk_test_x",
                             stripe_webhook_secret=WEBHOOK_SECRET, billing_required=True)
    with TestClient(create_app(settings)) as c:
        c.app.state.mgr.billing._client = FakeStripe()
        c.post("/api/access", json={"code": "code-1"})
        c.post("/api/users", json={"id": "u_alice", "name": "Alice"})
        r = c.post("/api/sessions", json={"user_id": "u_alice", "task": "t", "provider": "anthropic", "model": "claude-sonnet-5-5"})
        assert r.status_code == 402 and r.json()["payment_required"]
        view = c.get("/api/billing").json()
        assert view["required"] and view["test_mode"] and view["plan"]["amount"] == 2900
        assert c.post("/api/billing/checkout").json()["url"].startswith("https://checkout.stripe.test/")

        stripe_side = TestClient(c.app)  # no access-code cookie, like Stripe's servers
        body, sig = signed({"id": "evt_x", "object": "event", "type": "product.created", "data": {"object": {"id": "prod_x"}}})
        ok = stripe_side.post("/api/billing/webhook", content=body, headers={"Stripe-Signature": sig})
        assert ok.status_code == 200 and ok.json() == {"received": "product.created"}
        bad = stripe_side.post("/api/billing/webhook", content=body, headers={"Stripe-Signature": "t=1,v1=bad"})
        assert bad.status_code == 400
