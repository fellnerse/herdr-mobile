#!/usr/bin/env node
/* The tokens page: node tools/test-usage.js
 *
 * The gateway hands over a row per hour, per agent, per model, per project.
 * Everything anybody reads on that page is arithmetic on those rows, and the
 * failures worth catching are the quiet ones: an hour dropped because the phone
 * is not on UTC, a day that never happened being skipped rather than drawn
 * empty, a legend that repaints itself when the range changes, a stacked bar
 * whose segments no longer add up to the column.
 *
 * Sliced out of app.js between two anchors, like the other suites - the half
 * above the anchor takes no part in the DOM, which is what makes it drivable
 * from node at all.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "app.js");
const FROM = "  /* ---- Tokens over time --";
const TO = "  /* The page itself:";

function load() {
  const src = fs.readFileSync(SRC, "utf8");
  const from = src.indexOf(FROM);
  const to = src.indexOf(TO);
  if (from < 0 || to < 0) throw new Error(`anchors moved in ${SRC}`);
  const PRELUDE = `
    const escapeHtml = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  `;
  return new Function(
    `${PRELUDE}${src.slice(from, to)}
     return { fmtTokens, fmtCount, modelLabel, usageColumns, usageSeries, partOf,
              niceMax, usageChart, usageReadout, usageKinds, usageProjects,
              usageNote, rowTotal, SERIES_COLOURS, OTHER_COLOUR,
              PAD_LEFT, PAD_RIGHT, PLOT_H, PAD_TOP, BAR_MAX };`
  )();
}

const u = load();

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failures++;
  console.log(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

function ok(name, condition, detail = "") {
  if (condition) return;
  failures++;
  console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
}

/* A row as the gateway sends it. The hour is UTC with the Z on it, which is the
   whole reason the bucketing below is worth testing. */
function row(hour, over = {}) {
  return {
    hour,
    agent: "claude",
    model: "claude-opus-5",
    project: "sheepit",
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    messages: 1,
    ...over,
  };
}

// -- the numbers as they are read ------------------------------------------

// Three significant figures at most: a bar labelled 12,483,904 is a bar nobody
// reads, and the exact figure is in no question anybody asks this page.
check("tokens: under a thousand are themselves", u.fmtTokens(842), "842");
check("tokens: thousands keep one decimal", u.fmtTokens(1248), "1.2K");
check("tokens: past ten they lose it", u.fmtTokens(12483), "12K");
check("tokens: and hundreds stay whole", u.fmtTokens(124830), "125K");
check("tokens: millions", u.fmtTokens(1248300), "1.2M");
check("tokens: billions", u.fmtTokens(2400000000), "2.4B");
check("tokens: a round one carries no decimal", u.fmtTokens(1000), "1K");
check("tokens: nothing is zero, not a dash", u.fmtTokens(0), "0");
check("turns are grouped", u.fmtCount(5191), "5,191");

// The id is not the label. The agent's own line already says whose model it is.
check("model: the vendor comes off", u.modelLabel("claude-opus-5"), "opus 5");
check("model: a dated id loses the date",
      u.modelLabel("claude-sonnet-4-5-20250929"), "sonnet 4 5");
check("model: another vendor's is left alone", u.modelLabel("gpt-5-codex"), "gpt 5 codex");

// -- what a column is ------------------------------------------------------

/* Buckets are local. The gateway counts in UTC because it cannot know which day
   that was for whoever is looking; a phone two hours east of it must still put
   23:30 UTC in the next morning. */
{
  const now = new Date(2026, 8, 18, 14, 30);          // 18 Sep 2026, 14:30 local
  const columns = u.usageColumns([], 1, now);
  check("24h: one column an hour", columns.length, 24);
  check("24h: the last one is the hour we are in", columns[23].label, "14:00");
  check("24h: the first one is 23 hours back", columns[0].label, "15:00");
}

{
  const now = new Date(2026, 8, 18, 14, 30);
  const columns = u.usageColumns([], 7, now);
  check("7d: a column a day", columns.length, 7);
  check("7d: today is last", columns[6].at.getDate(), 18);
  check("7d: six days back is first", columns[0].at.getDate(), 12);
}

/* A quiet day still takes up its width. A chart that only plots the days that
   happened puts Friday next to Monday and calls it a week. */
{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 16, 9, 0);             // the day before yesterday
  const columns = u.usageColumns([row(at.toISOString(), { output: 1000 })], 7, now);
  check("empty days are drawn", columns.map((c) => c.total),
        [0, 0, 0, 0, 1000, 0, 0]);
}

// Local midnight is what decides the day, not UTC midnight.
{
  const now = new Date(2026, 8, 18, 14, 30);
  const lateLastNight = new Date(2026, 8, 17, 23, 30);
  const columns = u.usageColumns(
    [row(lateLastNight.toISOString(), { output: 500 })], 7, now);
  check("a row lands on the local day it happened",
        columns.map((c) => c.total), [0, 0, 0, 0, 0, 500, 0]);
}

// Older than the range, or a clock that ran ahead: neither belongs to a column
// here, and neither may be quietly folded into the nearest one.
{
  const now = new Date(2026, 8, 18, 14, 30);
  const old = new Date(2026, 7, 1, 9, 0).toISOString();
  const ahead = new Date(2026, 8, 19, 9, 0).toISOString();
  const columns = u.usageColumns(
    [row(old, { output: 900 }), row(ahead, { output: 900 })], 7, now);
  check("out of range is dropped, not clamped",
        columns.reduce((sum, c) => sum + c.total, 0), 0);
}

// A column is the sum of all four kinds - the page counts what was sent to a
// model, and cache reads are most of that.
{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 18, 10, 0).toISOString();
  const columns = u.usageColumns([row(at, {
    input: 10, output: 100, cache_read: 9000, cache_write: 890, messages: 3,
  })], 1, now);
  const column = columns.find((c) => c.total);
  check("a column totals every kind", column.total, 10000);
  check("a column keeps the turns", column.turns, 3);
  check("a column keeps the split", column.kinds,
        { input: 10, output: 100, cache_read: 9000, cache_write: 890 });
}

// -- which model gets which colour -----------------------------------------

/* Colour follows the model, not its rank. Switching from a week to a day
   changes which model is biggest all the time; if that repainted the chart,
   the legend would have to be re-read on every tap. */
{
  const week = u.usageSeries([
    row("2026-09-18T10:00:00Z", { model: "claude-opus-5", output: 10 }),
    row("2026-09-18T10:00:00Z", { model: "claude-sonnet-5", output: 90 }),
  ]);
  const day = u.usageSeries([
    row("2026-09-18T10:00:00Z", { model: "claude-opus-5", output: 90 }),
    row("2026-09-18T10:00:00Z", { model: "claude-sonnet-5", output: 10 }),
  ]);
  check("series are in name order", week.map((s) => s.model),
        ["claude-opus-5", "claude-sonnet-5"]);
  check("a bigger model does not take another's colour",
        day.map((s) => s.colour), week.map((s) => s.colour));
  check("the first slot is the first hue", week[0].colour, u.SERIES_COLOURS[0]);
}

/* Past five models there is no sixth hue: the smallest fold into one grey, and
   a folded column still counts every one of them exactly once. */
{
  const models = ["a", "b", "c", "d", "e", "f", "g"];
  const rows = models.map((m, i) =>
    row("2026-09-18T10:00:00Z", { model: m, output: (i + 1) * 100 }));
  const series = u.usageSeries(rows);
  check("five hues and an other", series.length, 6);
  check("other is last", series[5].model, "other");
  check("other is the grey", series[5].colour, u.OTHER_COLOUR);
  check("other says how many it is holding", series[5].label, "other (2)");
  check("other is the two smallest", series[5].total, 100 + 200);

  const columns = u.usageColumns(rows, 1, new Date(Date.parse("2026-09-18T10:30:00Z")));
  const column = columns.find((c) => c.total);
  const stacked = series.reduce((sum, s) => sum + u.partOf(column, s), 0);
  check("a stack still adds up to its column", stacked, column.total);
}

// -- the chart -------------------------------------------------------------

// The top gridline is a number somebody can hold in their head.
check("nice max: rounds up to one", u.niceMax(880), 1000);
check("nice max: rounds up to two", u.niceMax(1400), 2000);
check("nice max: rounds up to five", u.niceMax(4200), 5000);
check("nice max: an exact power is left alone", u.niceMax(1000), 1000);
check("nice max: nothing has no scale", u.niceMax(0), 0);

function attrs(svg, tag) {
  return [...svg.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((m) => {
    const out = {};
    for (const [, k, v] of m[0].matchAll(/([a-z-]+)="([^"]*)"/g)) out[k] = v;
    return out;
  });
}

{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 18, 12, 0).toISOString();
  const series = u.usageSeries([
    row(at, { model: "claude-opus-5", output: 600 }),
    row(at, { model: "claude-sonnet-5", output: 400 }),
  ]);
  const columns = u.usageColumns([
    row(at, { model: "claude-opus-5", output: 600 }),
    row(at, { model: "claude-sonnet-5", output: 400 }),
  ], 1, now);
  const svg = u.usageChart(columns, series, 360);

  // A stacked column is one rect per series below the top, and the top one is
  // the path that carries the rounded data-end.
  const rects = attrs(svg, "rect").filter((r) => r.fill);
  const caps = attrs(svg, "path");
  check("one plain segment under the cap", rects.length, 1);
  check("one rounded data-end", caps.length, 1);
  check("the lower segment is the first hue", rects[0].fill, u.SERIES_COLOURS[0]);
  check("the cap is the second", caps[0].fill, u.SERIES_COLOURS[1]);

  // The gap between two segments is surface, not a stroke - and it is taken off
  // the top of the lower one, so the stack still measures its own total.
  const lower = Number(rects[0].height);
  const full = (600 / 1000) * u.PLOT_H;
  ok("the surface gap comes out of the segment below",
     Math.abs(lower - (full - 2)) < 0.01, `height ${lower}, expected ${full - 2}`);

  // Nothing is drawn outside the box the page measured.
  const right = Number(rects[0].x) + Number(rects[0].width);
  ok("a bar stays inside the plot", right <= 360 - u.PAD_RIGHT + 0.01,
     `bar ends at ${right}`);
  ok("a bar starts after the labels", Number(rects[0].x) >= u.PAD_LEFT,
     `bar starts at ${rects[0].x}`);
  ok("a bar is never thicker than the cap", Number(rects[0].width) <= u.BAR_MAX,
     `bar is ${rects[0].width} wide`);
  ok("the top gridline is labelled", svg.includes(">1K<"), svg.slice(0, 200));
}

// An empty range draws its gridlines and no marks at all - and above all it
// does not throw, which is what an empty range used to do to Math.max.
{
  const columns = u.usageColumns([], 7, new Date(2026, 8, 18, 14, 30));
  const svg = u.usageChart(columns, [], 360);
  check("nothing spent draws no marks", attrs(svg, "path").length, 0);
  check("but it still draws its scale", attrs(svg, "line").length, 3);
}

// The picked column is a wash behind the whole slot, so an hour with nothing in
// it can still be picked and still says so.
{
  const now = new Date(2026, 8, 18, 14, 30);
  const columns = u.usageColumns([], 1, now);
  const svg = u.usageChart(columns, [], 360, 3);
  check("a picked column is marked", attrs(svg, "rect").length, 1);
  const readout = u.usageReadout(columns, [], 3);
  ok("the readout names the picked hour", readout.includes(columns[3].label), readout);
  ok("an empty hour says so", readout.includes("nothing spent"), readout);
}

// With nothing picked the readout is the whole range, which is what the page
// opens showing.
{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 18, 12, 0).toISOString();
  const rows = [row(at, { output: 1200, messages: 4 })];
  const columns = u.usageColumns(rows, 1, now);
  const series = u.usageSeries(rows);
  const readout = u.usageReadout(columns, series, -1);
  ok("unpicked reads the range", readout.includes("everything shown"), readout);
  ok("and its total", readout.includes("1.2K"), readout);
  ok("and its turns", readout.includes("4 turns"), readout);
}

// -- what the range was made of -------------------------------------------

{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 18, 12, 0).toISOString();
  const columns = u.usageColumns([
    row(at, { input: 100, output: 300, cache_read: 500, cache_write: 100 }),
  ], 1, now);
  const tiles = u.usageKinds(columns);
  ok("the kinds are broken out", tiles.includes("cache read"), tiles);
  ok("and shown as a share", tiles.includes(">50%<"), tiles);
}

/* Projects are a ranking, so this one *is* ordered by size - the rule about
   colour following the entity is about colour, and nothing here is coloured. */
{
  const now = new Date(2026, 8, 18, 14, 30);
  const at = new Date(2026, 8, 18, 12, 0).toISOString();
  const rows = [
    row(at, { project: "small", output: 10 }),
    row(at, { project: "big", output: 900 }),
  ];
  const html = u.usageProjects(rows, new Date(2026, 8, 17));
  check("the biggest project is first",
        html.indexOf(">big<") < html.indexOf(">small<"), true);
  ok("the biggest fills its bar", html.includes("width:100%"), html);
}

// A project spent on before the range began is not this range's business.
{
  const before = new Date(2026, 8, 1, 12, 0).toISOString();
  const html = u.usageProjects([row(before, { project: "last month", output: 10 })],
                               new Date(2026, 8, 17));
  check("older spending is out of the ranking", html, "");
}

/* Identity never rests on colour alone: every model in the range is named
   under the chart whatever is picked, so dragging across an hour one of them
   sat out does not take its key off the page. */
{
  const now = new Date(2026, 8, 18, 14, 30);
  const opus = new Date(2026, 8, 18, 12, 0).toISOString();
  const sonnet = new Date(2026, 8, 18, 9, 0).toISOString();
  const rows = [
    row(opus, { model: "claude-opus-5", output: 600 }),
    row(sonnet, { model: "claude-sonnet-5", output: 400 }),
  ];
  const columns = u.usageColumns(rows, 1, now);
  const series = u.usageSeries(rows);
  const picked = columns.findIndex((c) => c.label === "12:00");
  const readout = u.usageReadout(columns, series, picked);
  ok("every model is named whatever is picked",
     readout.includes("opus 5 600") && readout.includes("sonnet 5 0"), readout);
  ok("the one that sat this hour out is dimmed, not dropped",
     /class="usage-chip muted"><i style="background:[^"]*"><\/i>sonnet 5 0/.test(readout),
     readout);
}

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("tokens page: all good");
