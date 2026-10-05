import { expect, test } from "@playwright/test";
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const PASSWORD = "ChangeMe-Dev-2026!";
test("admin manages branches, pipeline and a reviewed CSV import", async ({
  page,
  request,
}) => {
  const stamp = Date.now().toString();
  await request.post(`${API}/auth/login`, {
    data: { email: "admin@sunshine-skin.test", password: PASSWORD },
  });
  await page.goto("/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("admin@sunshine-skin.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home/);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/settings/branches");
  await page.getByRole("button", { name: "Add branch" }).click();
  await page
    .getByLabel("Branch name", { exact: true })
    .fill(`QA Branch ${stamp}`);
  await page.getByLabel("City", { exact: true }).fill("QA City");
  await page.getByRole("button", { name: "Save branch", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Branch saved.");
  const row = page
    .getByRole("listitem")
    .filter({ hasText: `QA Branch ${stamp}` });
  await expect(row).toContainText("QA City");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("City", { exact: true }).fill("Updated City");
  await page.getByRole("button", { name: "Save branch", exact: true }).click();
  await expect(row).toContainText("Updated City");
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.goto("/settings/pipeline");
  const stage = page.getByLabel("Stage 1 name", { exact: true });
  const original = await stage.inputValue();
  await stage.fill("New inquiry");
  await page
    .getByRole("button", { name: "Save pipeline", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Pipeline saved.");
  await page.reload();
  await expect(stage).toHaveValue("New inquiry");
  await stage.fill(original);
  await page
    .getByRole("button", { name: "Save pipeline", exact: true })
    .click();
  await page.goto("/people/import");
  await page
    .getByLabel(/CSV file/)
    .setInputFiles({
      name: "patients.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `First Name,Last Name,Email\nQuality,Example,qa-import-${stamp}@example.test\n`,
      ),
    });
  await page.getByRole("button", { name: "Review mapped rows" }).click();
  await expect(
    page.getByText("1 rows: 1 valid, 0 need correction."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1 created");
  await page.goto(
    `/people?search=${encodeURIComponent(`qa-import-${stamp}@example.test`)}`,
  );
  await page
    .getByRole("link", { name: "Quality Example", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Quality Example", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit details", exact: true }).click();
  await page.getByLabel("City", { exact: true }).fill("Updated Patient City");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/);
  await expect(
    page.getByText("Updated Patient City", { exact: false }),
  ).toBeVisible();
});

test("admin imports a WhatsApp template with CRM fields", async ({
  page,
  request,
}) => {
  await request.post(`${API}/auth/login`, {
    data: { email: "admin@sunshine-skin.test", password: PASSWORD },
  });
  await page.goto("/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("admin@sunshine-skin.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home/);
  await page.goto("/automations/templates");
  await page
    .getByRole("button", {
      name: "Load templates and refresh approvals",
      exact: true,
    })
    .click();
  await page
    .getByRole("combobox", { name: "WhatsApp template", exact: true })
    .selectOption("mock_greeting");
  await page
    .getByRole("combobox", { name: "Variable 1", exact: true })
    .selectOption("person.firstName");
  await page
    .getByRole("button", { name: "Import template", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Template imported");
  await expect(
    page.getByRole("link").filter({ hasText: "hello_patient" }),
  ).toContainText("Meta: approved");
  await page.screenshot({
    path: "/tmp/skincrm-template-import-qa.png",
    fullPage: true,
  });
});
