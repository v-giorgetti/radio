// Run against the listener Vite server; exercises actual UI components and styles.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const session = `station-overflow-${process.pid}`;
const browser = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
const sourceRoot = `/@fs${resolve(".")}`;
const baseUrl = process.env.STATION_TEST_URL ?? "http://localhost:5175/?state=live";
const evaluate = (expression) => {
  const output = execFileSync("agent-browser", ["--session", session, "--json", "eval", "--stdin"], { encoding: "utf8", input: expression });
  const response = JSON.parse(output);
  if (!response.success) throw new Error(JSON.stringify(response));
  return response.data.result;
};

async function check(sourceRoot) {
  const React = (await import("/node_modules/.vite/deps/react.js")).default;
  const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
  const ui = await import(`${sourceRoot}/packages/ui/src/index.ts`);
  const { LiveView } = await import(`${sourceRoot}/apps/host/src/views/Live.tsx`);
  const { LibraryView } = await import(`${sourceRoot}/apps/host/src/views/Library.tsx`);
  const { ProcessingCapacity } = await import(`${sourceRoot}/apps/host/src/views/ProcessingCapacity.tsx`);
  await import(`${sourceRoot}/apps/host/src/host.css`);
  await document.fonts.ready;
  document.getElementById("root").style.display = "none";
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  const h = React.createElement;
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 80));
    await new Promise(requestAnimationFrame);
  };
  const render = async (child, props = {}) => {
    root.render(h(ui.StationTheme, props, h(ui.TooltipProvider, null, child)));
    await settle();
  };
  const results = [];
  const expect = (condition, name) => results.push({ name, passed: Boolean(condition) });
  const long = "LongUnbrokenMetadata".repeat(20);
  const item = { id: "same-item", kind: "music", title: long, artists: [long], album: long };
  const playing = (value) => h("div", { style: { width: "100%", maxWidth: 560, margin: "auto" } },
    h(ui.NowPlaying, { item: value }));
  await render(playing(item));
  const marquees = [...mount.querySelectorAll(".r-marquee")];
  expect(marquees.length === 3, "Title, artist and album use overflow-aware text");
  expect(document.documentElement.scrollWidth <= innerWidth + 1, "Long public metadata stays inside the viewport");
  expect(marquees.every((m) => m.hasAttribute("data-overflowing")), "All overflowing metadata animates");
  for (const [index, m] of marquees.entries()) {
    const text = m.querySelector(".r-marquee__inner");
    const anim = text?.getAnimations()[0];
    expect(!!anim, `Metadata ${index + 1} has a scrolling animation`);
    if (!anim) continue;
    anim.pause();
    const duration = anim.effect.getTiming().duration;
    anim.currentTime = duration / 2;
    await settle();
    const distance = text.scrollWidth - m.clientWidth;
    const endX = new DOMMatrixReadOnly(getComputedStyle(text).transform).m41;
    expect(Math.abs(endX + distance) <= 2, `Metadata ${index + 1} reaches the final characters`);
    expect(getComputedStyle(m).maskImage === "none", `Metadata ${index + 1} does not fade away its final characters`);
    anim.currentTime = duration - 1;
    await settle();
    const startX = new DOMMatrixReadOnly(getComputedStyle(text).transform).m41;
    expect(Math.abs(startX) <= 1, `Metadata ${index + 1} returns to the beginning`);
  }
  const first = marquees[0];
  first.querySelector("span").getAnimations()[0].play();
  first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await settle();
  expect(first.querySelector("span").getAnimations().every((a) => a.playState === "paused"), "Hover can pause scrolling");
  first.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  first.focus();
  await settle();
  expect(first.querySelector("span").getAnimations().every((a) => a.playState === "paused"), "Keyboard focus can pause scrolling");
  first.blur();

  await render(playing({ ...item, title: "Short", artists: ["Artist"], album: "Album" }));
  expect([...mount.querySelectorAll(".r-marquee")].every((m) => !m.hasAttribute("data-overflowing") && !m.querySelector("span").getAnimations().length), "Short text is static after a metadata change");
  await render(playing(item), { reducedMotion: "always" });
  expect([...mount.querySelectorAll(".r-marquee")].every((m) => getComputedStyle(m).textOverflow === "ellipsis" && m.getAnimations({ subtree: true }).length === 0 && m.title === long), "Reduced motion uses static, accessible full-text fallbacks");
  await render(playing(item));
  const resized = mount.querySelector(".r-marquee");
  const oldWidth = resized.clientWidth;
  mount.firstElementChild.style.width = "260px";
  await settle();
  expect(resized.clientWidth < oldWidth && resized.hasAttribute("data-overflowing"), "Overflow is remeasured after resizing");
  mount.firstElementChild.style.width = "";

  const track = { id: "music", kind: "music", title: long, artists: [long], album: long, durationSec: 180, source: "files" };
  const jingle = { ...track, id: "jingle", kind: "jingle" };
  const playlist = { id: "fallback", name: long, trackIds: [track.id], shuffle: false };
  const state = {
    tracks: [track, jingle], broadcasting: true, elapsed: 20, playCount: 1,
    currentId: track.id, queue: [track.id], pendingJingles: [],
    rules: [], playlists: [playlist], listeners: 3, jobs: [],
    fallbackPlaylistId: playlist.id,
  };
  const sim = { state, dispatch: async () => {}, current: track, fallback: playlist,
    trackById: (id) => state.tracks.find((t) => t.id === id),
    prediction: { dueNow: [], after: { [track.id]: [jingle] } }, error: null };
  await render(h("main", { className: "host-main" }, h(LiveView, { sim })));
  expect(document.documentElement.scrollWidth <= innerWidth + 1, "Long queue/jingle/playlist metadata never widens the host page");
  if (document.documentElement.scrollWidth > innerWidth + 1) {
    results.push({ name: `Overflow bounds: ${JSON.stringify([...mount.querySelectorAll(".host-main,.host-live,.host-col,.host-card,.host-queue,.host-queue__item,.host-queue__row,.host-queue__jingle,.host-queue__meta,.host-queue__fallback")].map((e) => ({ selector: e.className, width: Math.round(e.getBoundingClientRect().width), scroll: e.scrollWidth })))}`, passed: false });
  }
  const card = mount.querySelector(".host-onair").getBoundingClientRect();
  const title = mount.querySelector(".host-onair__title");
  expect(title.getBoundingClientRect().right <= card.right && getComputedStyle(title).textOverflow === "ellipsis", "Host on-air title stays contained with ellipsis");
  const remove = mount.querySelector(".host-queue__row button:last-child").getBoundingClientRect();
  expect(remove.right <= innerWidth, "Queue controls remain visible with long metadata");
  await render(h("main", { className: "host-main" }, h(LibraryView, { sim, jobs: [], onImport: () => {} })));
  expect(document.documentElement.scrollWidth <= innerWidth + 1, "Long library titles stay contained");

  await render(h(ui.Dialog, { open: true, onOpenChange: () => {}, title: `Delete ${long}?`, description: "Remove track" }, "Confirmation"));
  const dialog = mount.querySelector(".r-dialog");
  expect(dialog.scrollWidth <= dialog.clientWidth + 1, "Long delete-dialog title stays within the dialog");
  const close = dialog.querySelector("button[aria-label='Close']").getBoundingClientRect();
  expect(close.right <= dialog.getBoundingClientRect().right, "Delete-dialog close control stays visible");
  const measured = { processingHeadroom: { realtimeFactor: 2.5, measuredAt: Date.now(), source: "library", sampleDurationMs: 3000, crossfadeVoices: 2, sampleCount: 1, streamFormat: "mp3", bitrate: 128, normalizeLoudness: true } };
  await render(h(ProcessingCapacity, { state: measured }));
  expect(mount.textContent.includes("2.5×") && mount.textContent.includes("MP3 · 128 kbps"), "Processing capacity identifies its measured encoding profile");
  await render(h(ProcessingCapacity, { state: { ...measured, settings: { streamFormat: "opus", bitrate: 128, normalizeLoudness: true, crossfadeMs: 3000 } } }));
  expect(mount.textContent.includes("Previous settings"), "Changing codec marks an old capacity result as stale");
  root.unmount();
  mount.remove();
  return { width: innerWidth, results, failures: results.filter((r) => !r.passed) };
}

try {
  browser("open", baseUrl);
  const all = [];
  for (const width of [1280, 390]) {
    browser("set", "viewport", String(width), "900");
    const data = evaluate(`(${check.toString()})(${JSON.stringify(sourceRoot)})`);
    all.push(data);
    console.log(`${width}px: ${data.results.length - data.failures.length}/${data.results.length} checks passed`);
    for (const failure of data.failures) console.error(`  FAIL: ${failure.name}`);
  }
  if (all.some((result) => result.failures.length)) process.exitCode = 1;
  // Change the OS preference while the same component is mounted, not just at startup.
  evaluate(`(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { Marquee, StationTheme } = await import(${JSON.stringify(`${sourceRoot}/packages/ui/src/index.ts`)});
    const mount = document.createElement('div'); mount.id = 'motion-preference-check'; mount.style.width = '200px'; document.body.appendChild(mount);
    const root = createRoot(mount);
    root.render(React.createElement(StationTheme, null, React.createElement(Marquee, null, 'Long text for checking reduced motion preference changes '.repeat(10))));
    await new Promise(r => setTimeout(r, 100));
    return true;
  })()`);
  for (const reduce of [true, false]) {
    browser("set", "media", "light", ...(reduce ? ["reduced-motion"] : []));
    const result = evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 100));
      const m = document.querySelector('#motion-preference-check .r-marquee');
      return { preference: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animations: m.getAnimations({subtree: true}).length };
    })()`);
    if (result.preference !== reduce || (result.animations === 0) !== reduce) throw new Error(`Changing reduced motion to ${reduce} did not update the mounted component: ${JSON.stringify(result)}`);
  }
  console.log("OS reduced-motion changes: 2/2 checks passed");
} finally {
  browser("close");
}
