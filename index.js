// ==UserScript==
// @name         Deadshot.io ESP & Memory Aimbot & Silent Aimbot & No recoil
// @namespace    http://tampermonkey.net/
// @description  ESP & Memory Aimbot & Silent Aimbot & No recoil for deadshot.io
// @version      1.0.3
// @author       ovftank
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deadshot.io
// @match        *://deadshot.io/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      deadshot-cheat.netlify.app
// @run-at       document-start
// @license MIT
// @downloadURL https://update.greasyfork.org/scripts/572110/Deadshotio%20ESP%20%20Memory%20Aimbot%20%20Silent%20Aimbot%20%20No%20recoil.user.js
// @updateURL https://update.greasyfork.org/scripts/572110/Deadshotio%20ESP%20%20Memory%20Aimbot%20%20Silent%20Aimbot%20%20No%20recoil.meta.js
// ==/UserScript==

(() => {
	'use strict';

	const TARGET_METHOD = '__wbg_eval_335a7ff6cdb2b16d';
	const CUSTOM_SCRIPT_URL = 'https://deadshot-cheat.netlify.app/index.js';

	let customCode = GM_getValue('cached_code', null);
	let isFirstTime = !customCode;

	const fetchAndCacheCode = () => {
		GM_xmlhttpRequest({
			method: 'GET',
			url: `${CUSTOM_SCRIPT_URL}?t=${Date.now()}`,
			onload: (res) => {
				if (res.status === 200 && res.responseText.length > 1000) {
					const newCode = res.responseText;
					GM_setValue('cached_code', newCode);
					if (isFirstTime) {
						location.reload();
					}
					customCode = newCode;
				}
			},
			onerror: (err) => console.error('err fetch:', err),
		});
	};

	fetchAndCacheCode();

	const patchImports = (importObject) => {
		for (const ns in importObject) {
			const mod = importObject[ns];
			if (mod?.[TARGET_METHOD]) {
				const original = mod[TARGET_METHOD];
				mod[TARGET_METHOD] = (...args) => {
					if (customCode) {
						try {
							(0, eval)(customCode);
							return;
						} catch (e) {
							console.error('err eval:', e);
						}
					}
					return original.apply(this, args);
				};
			}
		}
	};

	const _origInstantiate = WebAssembly.instantiate;
	WebAssembly.instantiate = async (buffer, imports) => {
		if (imports) patchImports(imports);
		return _origInstantiate.call(WebAssembly, buffer, imports);
	};

	const _origStreaming = WebAssembly.instantiateStreaming;
	WebAssembly.instantiateStreaming = async (source, imports) => {
		if (imports) patchImports(imports);
		return _origStreaming.call(WebAssembly, source, imports);
	};
})();
