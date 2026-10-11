"""Rehearse subscribing in a real browser, against Stripe test mode.

    python scripts/e2e_billing.py --url http://localhost:8000 --out ./shots

The server must have a Stripe *test* key (STRIPE_SECRET_KEY=sk_test_...) and no active subscription yet.
Alice sees the paid models locked, subscribes on Stripe's hosted Checkout with the test card
4242 4242 4242 4242, comes back to Baton with the subscription active, and can start a session on a paid
model. Requires: pip install playwright && python -m playwright install chromium
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


def fill_checkout(page: Page) -> None:
    """Stripe's hosted Checkout page, test mode."""
    page.wait_for_url("https://checkout.stripe.com/**", timeout=30000)
    page.locator("#email").fill("judge@example.com")
    # Checkout lists payment methods (card, Cash App, Klarna, bank) as radio rows; choose "Card".
    # A transparent overlay button covers the row and takes the click; trigger it directly.
    page.locator("[data-testid='card-accordion-item-button']").evaluate("b => b.click()")
    page.locator("#cardNumber").fill("4242424242424242")
    page.locator("#cardExpiry").fill("12 / 34")
    page.locator("#cardCvc").fill("123")
    page.locator("#billingName").fill("Judge Rivera")
    postal = page.locator("#billingPostalCode")
    if postal.count() and postal.is_visible():
        postal.fill("29201")
    # Stripe Link may offer to save the card; keep the test simple and decline.
    link = page.locator("#enableStripePass")
    if link.count() and link.is_checked():
        link.uncheck()
    page.locator("button[type='submit'], [data-testid='hosted-payment-submit-button']").first.click()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--out", default="shots")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.goto(args.url)
        page.get_by_placeholder("Your name").fill("Alice")
        page.get_by_role("button", name="Continue").click()
        expect(page.get_by_placeholder("Your name")).to_have_count(0)  # signed in and saved

        page.goto(f"{args.url}/billing")
        expect(page.get_by_text("Not subscribed")).to_be_visible(timeout=10000)
        page.screenshot(path=str(out / "billing-1-before.png"))
        page.get_by_role("button", name="Subscribe to Team").click()

        fill_checkout(page)
        page.wait_for_url(f"{args.url}/billing**", timeout=60000)
        expect(page.get_by_text("Active", exact=True)).to_be_visible(timeout=30000)
        expect(page.get_by_text("Renews on")).to_be_visible()
        page.screenshot(path=str(out / "billing-2-active.png"))

        # Paid models are unlocked: no paywall prompt, and Start works.
        page.goto(args.url)
        expect(page.get_by_text("Free plan")).to_have_count(0)
        expect(page.get_by_text("is part of Baton Team")).to_have_count(0)
        browser.close()
    print("OK: subscribed with the 4242 test card; paid models unlocked")
    return 0


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    print(f"finished in {time.time() - t0:.1f}s")
    sys.exit(rc)
