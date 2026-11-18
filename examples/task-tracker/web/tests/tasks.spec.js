import { test, expect } from "@playwright/test";
test("task lifecycle persists through reload without console or network errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("requestfailed", (r) => errors.push(r.url()));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  const title = `Browser task ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "New task title" }).fill(title);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await page.reload();
  await expect(row).toBeVisible();
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row).toBeVisible();
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/api/tasks/"),
  );
  await row.getByRole("button", { name: `Delete "${title}"` }).click();
  await (await deletion).finished();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("API failure is visible and can be dismissed", async ({ page }) => {
  await page.route("**/api/tasks", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Service unavailable" }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Service unavailable");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("Clear completed button deletes completed tasks", async ({ page }) => {
  const title = `Completed task ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "New task title" }).fill(title);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("checkbox").click();
  await expect(row.getByRole("checkbox")).toBeChecked();
  const clearBtn = page.getByRole("button", { name: "Clear completed", exact: true });
  await expect(clearBtn).toBeVisible();
  const clearResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/api/tasks/completed"),
  );
  await clearBtn.click();
  await (await clearResponse).finished();
  await expect(row).toHaveCount(0);
});
