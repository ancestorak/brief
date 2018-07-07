"use strict";

const init = async () => {
    await Prefs.init();
	await Database.init();
	await render();
}

const render = async () => {
	let entries = await Ticker.data();

	let canvas = document.getElementById("canvas");
	var ctx = await Ticker.toCanvas(canvas);
}

window.addEventListener('load', () => init(), {once: true, passive: true});
Comm.registerObservers({
	'feedlist-updated': render,
	'entries-updated': render,
});
