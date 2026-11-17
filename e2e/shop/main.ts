// The fixture front end: a pretend shop whose buttons fail in the ways real
// applications do. It uses the stock Sentry browser SDK with default options.

import * as Sentry from "@sentry/browser";

const params = new URLSearchParams(window.location.search);

Sentry.init({
  dsn: params.get("dsn") ?? "",
  release: params.get("release") ?? "shop@1.0.0",
  environment: params.get("environment") ?? "e2e",
});

const inFlight: Promise<void>[] = [];
let clicks = 0;

function applyDiscount(code: string): never {
  throw new TypeError(`Discount code ${code} is not valid for this basket`);
}

async function chargeCard(): Promise<void> {
  await Promise.resolve();

  throw new Error("Payment gateway timed out");
}

function saveProfile(): void {
  Sentry.setUser({ id: "u-481", email: "ada@example.com", username: "ada" });
  Sentry.setTag("feature", "profile");
  Sentry.setTag("plan", "pro");
  Sentry.addBreadcrumb({ category: "profile", message: "Opened profile form", level: "info" });
  Sentry.addBreadcrumb({ category: "profile", message: "Validation passed", level: "info" });

  try {
    throw new RangeError("Profile photo exceeds the upload limit");
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        attempt: 3,
        password: "hunter2",
        apiToken: "tok_live_abcdef",
        cardNumber: "4111 1111 1111 1111",
        note: "kept as is",
      },
    });
  }
}

function loadOrder(): void {
  clicks += 1;

  // A different order number every time, and a UUID for good measure.
  const order = 48_000 + clicks * 17;

  Sentry.captureException(
    new Error(`Order ${order} could not be loaded for session ${crypto.randomUUID()}`),
  );
}

function checkout(): void {
  const declined = new Error("Card was declined by the issuer");

  throw new Error("Checkout could not be completed", { cause: declined });
}

function sync(region: string): void {
  Sentry.withScope((scope) => {
    scope.setFingerprint(["inventory-sync"]);
    scope.setTag("region", region);
    Sentry.captureException(new Error(`Inventory sync failed in ${region}: upstream returned 502`));
  });
}

function search(): void {
  clicks += 1;

  const shard = clicks % 2 === 0 ? "shard-a" : "shard-b";

  Sentry.withScope((scope) => {
    scope.setFingerprint(["{{ default }}", shard]);
    Sentry.captureException(new Error("Search index is unavailable"));
  });
}

function throwText(): never {
  // Old code that throws something that is not an Error.
  throw "legacy widget exploded";
}

const actions = new Map<string, () => void>([
  ["apply-discount", () => applyDiscount("SPRING-20")],
  ["pay", () => inFlight.push(chargeCard())],
  ["save-profile", saveProfile],
  [
    "check-stock",
    () => Sentry.captureMessage("Stock level is low for the featured product", "warning"),
  ],
  ["load-order", loadOrder],
  ["checkout", checkout],
  ["sync-eu", () => sync("eu-west")],
  ["sync-us", () => sync("us-east")],
  ["search", search],
  ["throw-text", throwText],
]);

for (const [id, action] of actions) {
  document.querySelector(`#${id}`)?.addEventListener("click", action);
}

const status = document.querySelector("#status");

if (status !== null) {
  status.textContent = "ready";
}
