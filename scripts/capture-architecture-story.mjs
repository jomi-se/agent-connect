import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

const source = resolve(process.argv[2] ?? "Architecture Story - Desktop.html");
const output = resolve(process.argv[3] ?? "submission-assets/architecture");
const chapters = [3, 6, 4, 3];

await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
await page.waitForTimeout(1_000);

for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
  const chapter = chapterIndex + 1;
  const stepCount = chapters[chapterIndex];

  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const progress = (stepIndex + 0.5) / stepCount;
    await page.evaluate(
      ({ chapter, progress }) => {
        const section = document.querySelector(`[data-ch="${chapter}"]`);
        if (!section) throw new Error(`Missing chapter ${chapter}`);
        const travel = Math.max(1, section.offsetHeight - window.innerHeight);
        window.scrollTo(0, section.offsetTop + progress * travel);
      },
      { chapter, progress },
    );
    await page.waitForTimeout(180);

    const filename = `chapter-${chapter}-step-${stepIndex + 1}.png`;
    await page.screenshot({ path: resolve(output, filename) });
    console.log(filename);
  }
}

await browser.close();
