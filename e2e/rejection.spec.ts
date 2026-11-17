// What must not get in: events sent with a key that is wrong, revoked or
// belongs to a different project.

import { expect, test } from "@playwright/test";

import { clickAndSend, listIssues, newProject, openShop, waitForIssue } from "./support";
import { ORG } from "./urls";

test("an unknown key is refused and nothing is stored", async ({ page, request }) => {
  const fixture = await newProject(request, "Unknown key");
  const forged = fixture.key.dsn.replace(fixture.key.publicKey, "0".repeat(32));

  await openShop(page, fixture, { dsn: forged });

  const response = await clickAndSend(page, "apply-discount");

  expect(response.status()).toBe(401);

  // A valid event sent afterwards is the only one that arrives.
  await openShop(page, fixture);
  await page.click("#checkout");

  expect((await waitForIssue(request, fixture)).title).toBe(
    "Error: Checkout could not be completed",
  );
});

test("a revoked key is refused", async ({ page, request }) => {
  const fixture = await newProject(request, "Revoked key");
  const { project, key } = fixture;

  const revoked = await request.put(`/api/0/projects/${ORG}/${project.slug}/keys/${key.id}/`, {
    data: { status: "revoked" },
  });

  expect(revoked.status()).toBe(200);

  await openShop(page, fixture);

  expect((await clickAndSend(page, "apply-discount")).status()).toBe(401);
  expect(await listIssues(request, fixture)).toHaveLength(0);
});

test("a key cannot write to another project", async ({ page, request }) => {
  const owner = await newProject(request, "Key owner");
  const target = await newProject(request, "Key target");
  const crossed = owner.key.dsn.replace(/\/\d+$/, `/${target.project.id}`);

  await openShop(page, owner, { dsn: crossed });

  expect((await clickAndSend(page, "apply-discount")).status()).toBe(401);
  expect(await listIssues(request, target)).toHaveLength(0);
  expect(await listIssues(request, owner)).toHaveLength(0);
});

test("the browser may read the response across origins", async ({ page, request }) => {
  const fixture = await newProject(request, "CORS");

  await openShop(page, fixture);

  const response = await clickAndSend(page, "apply-discount");

  expect(response.status()).toBe(200);
  expect(response.headers()["access-control-allow-origin"]).toBeDefined();
});
