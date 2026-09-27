import { expect, test, type Page } from "@playwright/test";

/**
 * Behavioural browser tests. The page exposes read-only views of the colony
 * on `window.__hollow` (the same data the census and cards read) plus the
 * same commands the controls use.
 */

type Hollow = {
  ready: () => boolean;
  census: () => { population: number; tick: number; alarm: number; births: number; deaths: number; volume: number; stores: number; foodGathered: number } | null;
  tick: () => number;
  frames: () => number;
  positions: (n?: number) => { serial: number; x: number; y: number }[];
  worldToClient: (x: number, y: number) => { x: number; y: number } | null;
  foods: () => { id: number; kind: number; x: number; amount: number; initial: number }[];
  card: () => { serial: number; alive: boolean; x: number; y: number; loads: number; ageSeconds: number; task: number } | null;
  letters: () => { key: string; ch: string; state: number }[];
  takenOnPage: () => number;
  savedAt: () => number | null;
  absence: () => { text: string } | null;
  layout: () => { cell: number; camRow: number };
};

async function open(page: Page, query = "") {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /hydrat/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?fresh&seed=7&weather=dry${query}`);
  await page.waitForFunction(() => (window as unknown as { __hollow?: Hollow }).__hollow?.ready() && (window as unknown as { __hollow: Hollow }).__hollow.tick() > 5);
  return errors;
}

const h = <T>(page: Page, fn: (h: Hollow) => T) =>
  page.evaluate((src) => {
    const f = new Function("h", `return (${src})(h)`);
    return f((window as unknown as { __hollow: Hollow }).__hollow);
  }, fn.toString()) as Promise<Awaited<T>>;

test("the colony changes over time with no input", async ({ page }) => {
  await open(page);
  const a = await h(page, (h) => ({ tick: h.tick(), pos: h.positions(200) }));
  await page.waitForTimeout(4000);
  const b = await h(page, (h) => ({ tick: h.tick(), pos: h.positions(200) }));
  expect(b.tick).toBeGreaterThan(a.tick + 20);
  const before = new Map(a.pos.map((p) => [p.serial, p]));
  let moved = 0;
  for (const p of b.pos) {
    const q = before.get(p.serial);
    if (q && Math.hypot(p.x - q.x, p.y - q.y) > 0.5) moved++;
  }
  expect(moved).toBeGreaterThan(10);
});

test("stopping the clock really stops the simulation, and restarting resumes it", async ({ page }) => {
  await open(page);
  const stop = page.getByRole("button", { name: /stop the clock/i });
  await stop.click();
  await expect(page.getByRole("button", { name: /clock stopped/i })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1200);
  const t1 = await h(page, (h) => ({ tick: h.tick(), pos: h.positions(100) }));
  await page.waitForTimeout(2500);
  const t2 = await h(page, (h) => ({ tick: h.tick(), pos: h.positions(100) }));
  expect(t2.tick).toBe(t1.tick);
  expect(t2.pos).toEqual(t1.pos);
  await page.getByRole("button", { name: /clock stopped/i }).click();
  await page.waitForTimeout(1500);
  expect(await h(page, (h) => h.tick())).toBeGreaterThan(t1.tick);
});

test("knocking on the glass raises the alarm, which then fades", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 300));
  const before = await h(page, (h) => h.census()?.alarm ?? 0);
  await page.getByRole("button", { name: "Knock", exact: true }).click();
  const pt = await h(page, (h) => h.worldToClient(60, 150));
  await page.mouse.click(pt!.x, pt!.y);
  await expect.poll(async () => h(page, (h) => h.census()?.alarm ?? 0), { timeout: 5000 }).toBeGreaterThan(before + 20);
  await expect(page.getByText(/tapped the glass|At the knock|Another knock/).first()).toBeVisible({ timeout: 8000 });
});

test("offered honey is found by the colony", async ({ page }) => {
  await open(page, "&speed=4");
  const btn = page.getByRole("button", { name: "Honey", exact: true });
  // Keyboard activation places the offering directly on the surface.
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => h(page, (h) => h.foods().filter((f) => f.kind === 1).length)).toBe(1);
  await expect
    .poll(async () => h(page, (h) => h.foods().filter((f) => f.kind === 1).map((f) => f.initial - f.amount)[0] ?? 999), { timeout: 90_000, intervals: [2000] })
    .toBeGreaterThan(0);
});

test("a specimen card reflects a real ant's state", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 250));
  await page.waitForTimeout(500);
  // Click on the glass exactly where an ant is drawn.
  const target = await h(page, (h) => {
    const lay = h.layout();
    const pos = h.positions(4000).filter((p) => p.y > lay.camRow + 20 && p.y < lay.camRow + 120);
    const p = pos[Math.floor(pos.length / 2)];
    return { serial: p.serial, pt: h.worldToClient(p.x, p.y) };
  });
  await page.mouse.click(target.pt!.x, target.pt!.y);
  const card = page.getByRole("complementary", { name: /No\./ });
  await expect(card).toBeVisible();
  const serial = Number((await card.getByRole("heading").textContent())!.replace(/\D/g, ""));
  const data = await expect.poll(async () => h(page, (h) => h.card()?.serial ?? null)).toBe(serial).then(() => h(page, (h) => h.card()));
  const live = await h(page, (h) => h.positions(4000));
  const me = live.find((p) => p.serial === serial);
  expect(me).toBeTruthy();
  expect(Math.hypot(me!.x - data!.x, me!.y - data!.y)).toBeLessThan(6);
  await expect(card).toContainText(/Walked/);
  await expect(card).toContainText(String(data!.loads));
});

test("the colony persists across reloads and the return note appears", async ({ page }) => {
  await open(page);
  const census = await h(page, (h) => h.census());
  await expect.poll(async () => h(page, (h) => h.savedAt()), { timeout: 30_000 }).not.toBeNull();
  // Return nineteen hours later (the clock parameter moves the visitor's clock).
  await page.goto("/?seed=7&weather=dry&clock=%2B19h");
  await page.waitForFunction(() => (window as unknown as { __hollow?: Hollow }).__hollow?.ready());
  const note = page.getByRole("dialog", { name: /while you were away/i });
  await expect(note).toBeVisible();
  await expect(note).toContainText(/Absent 19 hours/);
  const after = await h(page, (h) => h.census());
  expect(after!.births + after!.deaths).toBeGreaterThan(census!.births + census!.deaths);
  await expect(page.getByRole("heading", { name: "Your visits" })).toBeAttached();
});

test("borrowed letters leave the accessible text intact", async ({ page }) => {
  await open(page, "&speed=4");
  await page.evaluate(() => window.scrollTo(0, 0));
  const fragment = page.locator('[data-stealable="f1"]');
  const fullText = (await fragment.locator(".sr-only").textContent())!;
  await expect.poll(async () => h(page, (h) => h.takenOnPage()), { timeout: 100_000, intervals: [2000] }).toBeGreaterThan(0);
  // Some glyph is visibly gone somewhere on the page...
  expect(await page.locator(".glyphs .taken").count()).toBeGreaterThan(0);
  // ...but every passage still reads whole to assistive technology.
  await expect(fragment.locator(".sr-only")).toHaveText(fullText);
  const a11y = await page.locator('[data-stealable]').evaluateAll((els) => els.every((el) => (el.querySelector(".sr-only")?.textContent ?? "").length > 20 && el.querySelector('[aria-hidden="true"]') !== null));
  expect(a11y).toBe(true);
  // Restoring puts every letter back.
  await page.getByRole("button", { name: /restore the notebook/i }).first().click();
  await expect.poll(async () => page.locator(".glyphs .taken").count()).toBe(0);
});

test("reduced motion is honoured: still plates, no camera tracking", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-still", "1");
  await expect(page.getByRole("checkbox", { name: /still plates/i })).toBeChecked();
  // The colony still lives underneath.
  const t1 = await h(page, (h) => h.tick());
  await page.waitForTimeout(1500);
  expect(await h(page, (h) => h.tick())).toBeGreaterThan(t1);
  // Following a specimen becomes a single jump, not tracking.
  await page.getByRole("button", { name: "Specimen", exact: true }).click();
  await expect(page.getByRole("button", { name: /show me where/i })).toBeVisible();
  await context.close();
});

for (const [w, hgt] of [
  [390, 844],
  [768, 1024],
  [1440, 900],
  [2560, 1200],
]) {
  test(`no horizontal overflow at ${w}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: w, height: hgt } });
    const page = await context.newPage();
    const errors = await open(page);
    for (const y of [0, 1500, 99999]) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(300);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw).toBeLessThanOrEqual(cw);
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("no console errors or hydration warnings while the colony runs", async ({ page }) => {
  const errors = await open(page);
  await page.getByRole("button", { name: "Lens", exact: true }).click();
  await page.mouse.move(400, 500);
  await page.getByRole("button", { name: "Scent", exact: true }).click();
  await page.getByRole("button", { name: "What now?", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /what is happening now/i })).toBeVisible();
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});
