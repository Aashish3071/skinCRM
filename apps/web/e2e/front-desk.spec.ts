import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * PRD M1 happy path: a walk-in arrives, is booked in, the visit is confirmed,
 * and the inquiry is closed as won — all through the real UI, as front desk.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const PASSWORD = "ChangeMe-Dev-2026!";
const FRONT_DESK = "frontdesk@sunshine-skin.test";
const PRACTITIONER = "Dr. Alex Chen";

/** A Tuesday three weeks out, so the slot is always in the future and inside hours. */
function bookingDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 21);
  while (date.getUTCDay() !== 2) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** The practitioner needs working hours for slots to exist; add them if a fresh database has none. */
async function ensureWorkingHours(request: APIRequestContext) {
  const login = await request.post(`${API}/auth/login`, { data: { email: "admin@sunshine-skin.test", password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const users = (await (await request.get(`${API}/users`)).json()).items as { id: string; fullName: string }[];
  const doctor = users.find((u) => u.fullName === PRACTITIONER);
  expect(doctor, `${PRACTITIONER} is seeded`).toBeTruthy();
  const hours = (await (await request.get(`${API}/working-hours`)).json()).items as { userId: string | null }[];
  if (!hours.some((h) => h.userId === doctor!.id || h.userId === null)) {
    const slots = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "17:00" }));
    expect((await request.put(`${API}/working-hours`, { data: { userId: doctor!.id, slots } })).ok()).toBeTruthy();
  }
}

test("walk-in → book → confirm visit → won", async ({ page, request }) => {
  await ensureWorkingHours(request);
  const tag = Date.now().toString().slice(-7);
  const suffix = [...tag].map((digit) => String.fromCharCode(97 + Number(digit))).join("");
  const name = `Quality Walkin ${suffix}`;

  await test.step("sign in as front desk", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(FRONT_DESK);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/home/);
  });

  await test.step("add the walk-in", async () => {
    await page.goto("/leads/new");
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Phone").fill(`305-55${tag.slice(0, 1)}-${tag.slice(-4)}`);
    await expect(page.getByRole("radio", { name: /walk/i })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Add lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name })).toBeVisible();
  });
  const leadUrl = page.url();

  await test.step("book a consultation", async () => {
    await page.getByRole("link", { name: "Book appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Book appointment" });
    await expect(dialog.getByText(name)).toBeVisible();
    await dialog.getByLabel("Staff member").selectOption({ label: PRACTITIONER });
    await dialog.getByLabel("Date").fill(bookingDate());
    const slot = dialog.getByRole("radio").and(page.locator(":not([disabled])")).first();
    await expect(slot).toBeVisible();
    await slot.check();
    await dialog.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("status")).toContainText("Appointment booked");
  });

  await test.step("the inquiry moved to Qualified on its own", async () => {
    await page.goto(leadUrl);
    await expect(page.getByRole("button", { name: /Qualified/ })).toHaveAttribute("aria-current", "step");
  });

  await test.step("confirm the visit on the calendar", async () => {
    await page.goto(`/calendar?date=${bookingDate()}&view=day`);
    await page.getByRole("button", { name: new RegExp(name) }).first().click();
    const dialog = page.getByRole("dialog", { name });
    await dialog.getByLabel("Appointment status").selectOption({ label: "Confirmed" });
    await dialog.getByRole("button", { name: "Update status" }).click();
    await expect(page.getByRole("status")).toContainText("marked confirmed");
  });

  await test.step("close the inquiry as won", async () => {
    await page.goto(leadUrl);
    await page.getByRole("button", { name: "Won", exact: true }).click();
    await expect(page.getByRole("button", { name: "Won", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByRole("button", { name: "Won", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});
