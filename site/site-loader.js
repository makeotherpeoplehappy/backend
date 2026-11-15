// Site-wide loader, registered in Webflow as the inline script
// "Backend loader" and applied to the whole site (footer). Loads Turnstile
// and the backend helper, and makes sure any early HF.sync() call waits for
// the backend version, so the site never writes done actions to Shopify.
(function(){var k='0x4AAAAAAGCRjQ8uAFbutAJA';function add(src,at){var s=document.createElement('script');s.src=src;for(var a in at){s.setAttribute(a,at[a])}document.head.appendChild(s);return s}add('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',{async:''});var b=add('/join/hf-backend.js',{'data-turnstile-sitekey':k});var ready=new Promise(function(r){b.onload=r;b.onerror=r});function early(){return ready.then(function(){return window.HFB?window.HFB.sync():null})}(function patch(){if(!window.HF){return setTimeout(patch,30)}if(!window.HFB){window.HF.sync=early}})()})();
