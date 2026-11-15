# /lab page in Webflow

A blank Webflow page with slug `lab`.

- Page settings → Custom code → Inside `<head>`:
  `<meta name="robots" content="noindex, nofollow">`
- Page settings → Custom code → Before `</body>`:
  `<script src="/join/lab.js" defer></script>`

The dashboard itself is `public/lab.js`, served by the backend at `/join/lab.js`.
Only accounts listed in the backend setting `LAB_EMAILS` can see the numbers.
