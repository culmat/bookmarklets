/**
 * @title Strip Tracking Parameters
 * @description Removes campaign and click-tracking query parameters (utm_*, fbclid,
 *              gclid, mc_eid, …) from the current URL and reloads. Gives you a clean
 *              link to share.
 * @order 40
 */
const noisy = /^(utm_|pk_|mc_|_hs|ref$|referrer$|fbclid$|gclid$|dclid$|msclkid$|igshid$|yclid$|twclid$|si$)/i;
const url = new URL(location.href);
const before = url.search;
for (const key of [...url.searchParams.keys()]) {
  if (noisy.test(key)) {
    url.searchParams.delete(key);
  }
}
if (url.search === before) {
  alert("No tracking parameters found.");
} else {
  location.replace(url.toString());
}
