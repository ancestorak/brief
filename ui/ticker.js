"use strict";

const init = async () => {
    await Prefs.init();
	await Database.init();
	document.body.style.color = Ticker.color;
	document.body.style.background = Ticker.background;
	document.body.style.font = Ticker.font;
	await render();
}

const clickEntry = (event, elem, url, entryId, feedId) => {
	if (event.button == 0 || event.button == 2) {
		Database.query({entries: [entryId]}).markRead(true);
		elem.parentNode.removeChild(elem);
		if (event.button == 0) {
			browser.tabs.create({url});
		}
	} else if (event.button == 1) {
		Database.query({feeds: [feedId]}).markRead(true);
	}
}

const render = async () => {
	let entries = await Ticker.data();

	const content = document.getElementById('content');
	content.textContent = "";

	entries.forEach((entry) => {
		let span = document.createElement('span');
		span.textContent = entry.title;
		let a = document.createElement('span');
		a.addEventListener('mouseup', (ev) => { return clickEntry(ev, a, entry.url, entry.id, entry.feedId) }, true);
		a.addEventListener('contextmenu', (ev) => {ev.preventDefault()}, true);
		a.appendChild(entry.img);
		a.appendChild(span);
		content.appendChild(a);
	});
}

window.addEventListener('load', () => init(), {once: true, passive: true});
Comm.registerObservers({
	'feedlist-updated': render,
	'entries-updated': render,
});
