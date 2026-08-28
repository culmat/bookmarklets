/**
 * @title Copy as Markdown Link
 * @description Copies the current page as `[title](url)`, ready to paste into any
 *              Markdown document. Square brackets in the title are escaped.
 * @order 10
 */
const title = document.title.replace(/[\[\]]/g, "\\$&");
navigator.clipboard.writeText("[" + title + "](" + location.href + ")");
