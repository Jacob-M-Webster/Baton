"""Subscription billing with Stripe: per-seat plans for the whole Baton workspace.

A deployment of Baton is one team's workspace. The team subscribes once through Stripe Checkout, to Team
(monthly) or Enterprise (annual, with a seat minimum), paying per seat for the people who drive agents;
viewers are free. The subscription (card, invoices, cancelling) is managed in Stripe's customer portal. While billing is required, real
models need an active subscription; the offline demo model, joining, watching and requests stay free.

State comes from Stripe, never from the browser: webhooks are signature-checked, and on every subscription
event the subscription is fetched fresh from Stripe, so out-of-order or replayed events can't regress it.
Subscriptions carry this workspace's id in their metadata, so several deployments (a laptop and a server,
say) can share one Stripe account without overwriting each other.
"""
from __future__ import annotations

import logging
import secrets
import time

from .config import Settings
from .db import DB

log = logging.getLogger("baton")

KV = "billing"
# past_due: Stripe is retrying a failed renewal; keep the team working while it does (and say so).
ACTIVE = {"active", "trialing", "past_due"}
FREE_PROVIDERS = {"demo", "external"}  # the offline demo model, and agents that bring their own model


class BillingError(Exception):
    pass


def _get(obj, key, default=None):
    """Field access that works on Stripe objects and plain dicts alike."""
    try:
        v = obj[key]
    except (KeyError, TypeError, IndexError):
        v = getattr(obj, key, default)
    return default if v is None else v


def _id(v) -> str | None:
    return v if isinstance(v, str) or v is None else _get(v, "id")


class Billing:
    def __init__(self, settings: Settings, db: DB, client=None):
        self.settings = settings
        self.db = db
        self._client = client
        self._price_ids: dict[str, str] = {}
        self._portal_ready = False

    # ---- configuration -------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return bool(self.settings.stripe_secret_key) or self._client is not None

    @property
    def required(self) -> bool:
        return self.enabled and self.settings.billing_required

    @property
    def test_mode(self) -> bool:
        return not (self.settings.stripe_secret_key or "").startswith(("sk_live_", "rk_live_"))

    @property
    def client(self):
        if self._client is None:
            from stripe import StripeClient  # imported on first use, like the model SDKs

            self._client = StripeClient(self.settings.stripe_secret_key)
        return self._client

    @property
    def workspace(self) -> str:
        """A stable id for this deployment, stamped on its Stripe subscription."""
        meta = self.db.get_kv("workspace")
        if not meta:
            meta = {"id": "ws_" + secrets.token_hex(6)}
            self.db.set_kv("workspace", meta)
        return meta["id"]

    @property
    def plans(self) -> dict[str, dict]:
        """The paid plans. `seat` is the price per seat per month; Enterprise is charged for a year at a time."""
        s = self.settings
        return {
            "team": {"name": "Team", "seat": s.team_seat_cents, "interval": "month", "min_seats": 1,
                     "lookup_key": "baton_team_seat_monthly"},
            "enterprise": {"name": "Enterprise", "seat": s.enterprise_seat_cents, "interval": "year",
                           "min_seats": s.enterprise_min_seats, "lookup_key": "baton_enterprise_seat_yearly"},
        }

    def _plan(self, plan: str) -> dict:
        if plan not in self.plans:
            raise BillingError(f"Unknown plan {plan!r}")
        return self.plans[plan]

    # ---- state ---------------------------------------------------------------------
    def state(self) -> dict:
        return self.db.get_kv(KV) or {}

    def active(self) -> bool:
        return self.state().get("status") in ACTIVE

    def allows(self, provider: str) -> bool:
        return not self.required or provider in FREE_PROVIDERS or self.active()

    def view(self) -> dict:
        st = self.state()
        s = self.settings
        return {
            "enabled": self.enabled,
            "required": self.required,
            "test_mode": self.enabled and self.test_mode,
            "currency": s.plan_currency,
            "plans": [{"id": k, "name": p["name"], "seat": p["seat"], "interval": p["interval"], "min_seats": p["min_seats"]}
                      for k, p in self.plans.items()],
            "plan": st.get("plan"),
            "seats": st.get("seats"),
            "active": self.active(),
            "status": st.get("status"),
            "current_period_end": st.get("current_period_end"),
            "cancel_at_period_end": bool(st.get("cancel_at_period_end")),
            "email": st.get("email"),
            "has_customer": bool(st.get("customer")),
        }

    # ---- Stripe objects we need ----------------------------------------------------
    async def price_id(self, plan: str = "team") -> str:
        """The plan's per-seat price. Found by lookup key, or created (with its product) the first time."""
        if plan in self._price_ids:
            return self._price_ids[plan]
        p, currency = self._plan(plan), self.settings.plan_currency
        amount = p["seat"] * (12 if p["interval"] == "year" else 1)
        found = await self.client.v1.prices.list_async({"lookup_keys": [p["lookup_key"]], "active": True, "limit": 1})
        data = _get(found, "data", [])
        if data and _get(data[0], "unit_amount") == amount and _get(data[0], "currency") == currency:
            self._price_ids[plan] = _get(data[0], "id")
            return self._price_ids[plan]
        # No price yet, or the configured amount changed: make a new one and move the lookup key to it.
        product = await self.client.v1.products.create_async({
            "name": f"Baton {p['name']}", "description": "Shared agent sessions, per seat. Viewers are free.",
        })
        price = await self.client.v1.prices.create_async({
            "product": _get(product, "id"), "unit_amount": amount, "currency": currency,
            "recurring": {"interval": p["interval"]}, "lookup_key": p["lookup_key"], "transfer_lookup_key": True,
        })
        self._price_ids[plan] = _get(price, "id")
        log.info("created Stripe price %s for Baton %s", self._price_ids[plan], p["name"])
        return self._price_ids[plan]

    async def _ensure_portal(self) -> None:
        """Stripe won't open a customer portal until one is configured; set up a sensible default once."""
        if self._portal_ready:
            return
        existing = await self.client.v1.billing_portal.configurations.list_async({"is_default": True, "limit": 1})
        if not _get(existing, "data", []):
            await self.client.v1.billing_portal.configurations.create_async({
                "business_profile": {"headline": "Manage your Baton subscription"},
                "features": {
                    "invoice_history": {"enabled": True},
                    "payment_method_update": {"enabled": True},
                    "customer_update": {"enabled": True, "allowed_updates": ["email", "name", "address"]},
                    "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
                },
            })
        self._portal_ready = True

    # ---- flows ---------------------------------------------------------------------
    async def checkout(self, base_url: str, plan: str = "team", seats: int = 1) -> str:
        """A Stripe Checkout page for `seats` seats of a plan. Stripe hosts the card form; no card data touches Baton."""
        if not self.enabled:
            raise BillingError("Billing isn't set up on this server (no STRIPE_SECRET_KEY)")
        if self.active():
            raise BillingError("This workspace already has an active subscription")
        p = self._plan(plan)
        st = self.state()
        params: dict = {
            "mode": "subscription",
            "line_items": [{
                "price": await self.price_id(plan), "quantity": max(seats, p["min_seats"]),
                # The seat count can still be changed on the Checkout page, but not below the plan's minimum.
                "adjustable_quantity": {"enabled": True, "minimum": p["min_seats"], "maximum": 10_000},
            }],
            "success_url": f"{base_url}/billing?checkout={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{base_url}/billing?canceled=1",
            "allow_promotion_codes": True,
            "client_reference_id": self.workspace,
            "subscription_data": {"metadata": {"baton_workspace": self.workspace, "baton_plan": plan}},
        }
        if st.get("customer"):
            params["customer"] = st["customer"]  # a returning customer keeps their history
        cs = await self.client.v1.checkout.sessions.create_async(params)
        return _get(cs, "url")

    async def portal(self, base_url: str) -> str:
        customer = self.state().get("customer")
        if not customer:
            raise BillingError("Subscribe first; then you can manage the subscription here")
        await self._ensure_portal()
        ps = await self.client.v1.billing_portal.sessions.create_async({"customer": customer, "return_url": f"{base_url}/billing"})
        return _get(ps, "url")

    async def sync_checkout(self, session_id: str) -> None:
        """Called when the browser comes back from Checkout, so it works even before (or without) webhooks."""
        cs = await self.client.v1.checkout.sessions.retrieve_async(session_id, {"expand": ["subscription"]})
        if _get(cs, "client_reference_id") != self.workspace or _get(cs, "mode") != "subscription":
            raise BillingError("That checkout belongs to a different workspace")
        sub = _get(cs, "subscription")
        if sub:
            email = _get(_get(cs, "customer_details", {}), "email")
            if isinstance(sub, str):
                sub = await self.client.v1.subscriptions.retrieve_async(sub)
            self._save(sub, email)

    async def refresh(self, subscription_id: str) -> None:
        self._save(await self.client.v1.subscriptions.retrieve_async(subscription_id))

    def _save(self, sub, email: str | None = None) -> None:
        if _get(_get(sub, "metadata", {}), "baton_workspace") != self.workspace:
            return  # another deployment's subscription on the same Stripe account
        items = _get(_get(sub, "items", {}), "data", [])
        # Newer API versions keep the billing period on each item rather than on the subscription.
        period_end = (_get(items[0], "current_period_end") if items else None) or _get(sub, "current_period_end")
        prev = self.state()
        self.db.set_kv(KV, {
            "plan": _get(_get(sub, "metadata", {}), "baton_plan", "team"),  # subscriptions from before plans were Team
            "seats": _get(items[0], "quantity") if items else None,
            "customer": _id(_get(sub, "customer")),
            "subscription": _get(sub, "id"),
            "status": _get(sub, "status"),
            "current_period_end": period_end,
            "cancel_at_period_end": bool(_get(sub, "cancel_at_period_end", False)),
            "email": email or prev.get("email"),
            "updated_at": time.time(),
        })

    async def webhook(self, payload: bytes, signature: str | None) -> str:
        """Verify and apply a Stripe webhook. Returns the event type."""
        secret = self.settings.stripe_webhook_secret
        if not secret:
            raise BillingError("STRIPE_WEBHOOK_SECRET isn't set, so webhooks can't be verified")
        import stripe

        try:
            event = stripe.Webhook.construct_event(payload, signature or "", secret)
        except (ValueError, stripe.SignatureVerificationError) as e:
            raise BillingError(f"Invalid webhook: {e}") from e
        kind = _get(event, "type")
        obj = _get(_get(event, "data", {}), "object", {})
        if kind == "checkout.session.completed" and _get(obj, "mode") == "subscription":
            if _get(obj, "client_reference_id") == self.workspace:
                await self.sync_checkout(_get(obj, "id"))
        elif kind.startswith("customer.subscription."):
            await self.refresh(_get(obj, "id"))
        elif kind in ("invoice.paid", "invoice.payment_failed"):
            # Where an invoice names its subscription moved between API versions; accept either.
            sub = _get(obj, "subscription") or _get(_get(_get(obj, "parent", {}), "subscription_details", {}), "subscription")
            if _id(sub):
                await self.refresh(_id(sub))
        return kind
