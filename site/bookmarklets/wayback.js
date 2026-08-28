/**
 * @title Wayback Machine
 * @description Opens the most recent Internet Archive snapshot of the current page
 *              in a new tab. Useful when a page has changed, moved or died.
 * @order 30
 */
window.open("https://web.archive.org/web/2/" + encodeURIComponent(location.href), "_blank");
