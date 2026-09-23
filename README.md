# bookmarklets

A small collection of single-purpose browser bookmarklets, published at
**<https://culm.at/bookmarklets>**.

Each bookmarklet is one plain, readable `.js` file under
[`site/bookmarklets/`](site/bookmarklets/). The condensed `javascript:` link you drag onto
your bookmark bar is generated from that same file at build time by
[culm-at.github.io](https://github.com/culm-at/culm-at.github.io) — it is deliberately
**not** checked in, so the source you read is always exactly what you run.

## Adding a bookmarklet

Drop a `.js` file into `site/bookmarklets/` with a leading metadata block:

```js
/**
 * @title Copy as Markdown Link
 * @description What it does, in one or two sentences.
 * @order 10
 */
navigator.clipboard.writeText("[" + document.title + "](" + location.href + ")");
```

- `@title` — heading and the label of the draggable link. Defaults to the filename.
- `@description` — shown under the title. Optional.
- `@order` — sort position, ascending. Defaults to `999`, then alphabetical by title.

Write the body as a plain top-level script; it is wrapped in an IIFE and minified during
the build, so `const`/`let` declarations cannot collide with the host page. The metadata
comment is stripped from the condensed output.

## Previewing locally

```sh
./preview.sh
```

Then open <http://localhost:4321/bookmarklets> and drag the buttons onto your bookmarks
bar. The script runs the real renderer,
[culm-at.github.io](https://github.com/culm-at/culm-at.github.io). If that repo isn't
checked out next to this one, the script clones it there first. It needs
[bun](https://bun.sh). The page reloads whenever something under `site/` changes, but a
bookmark you already dragged keeps the old code, so drag it again after each edit.

## Mirrors

- <https://codeberg.org/culmat/bookmarklets>
- <https://codefloe.com/culmat/bookmarklets>

GitHub is the writable origin; the others are read-only pull mirrors.

## Licence

[CC0 1.0 Universal](LICENSE) — public domain. Take them, change them, ship them.
