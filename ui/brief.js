import {Database} from "/modules/database.js";
import {fetchFeed} from "/modules/feed-fetcher.js";
import {fetchFaviconAsURL} from "/modules/favicon-fetcher.js";
import {apply_i18n} from "/modules/i18n.js";
import {Prefs} from "/modules/prefs.js";
import {
    Comm, expectedEvent, wait, getElement
} from "/modules/utils.js";
import {
    FeedList, ViewList, TagList, DropdownMenus,
    ContextMenuModule,
    gCurrentView, setCurrentView,
    Commands,
} from "./feedlist.js";
import {FeedView} from "./feedview.js";


async function init() {
    // Start everything that can be done async, starting with the longest
    let contentIframePromise = loadContentIframe();
    let previewURL = new URLSearchParams(document.location.search).get("preview");
    let parsedFeedPromise = (previewURL !== null) ? fetchFeed(previewURL) : null;
    let prefsPromise = Prefs.init();
    let knownFeedsPromise = Database.getMasterFeeds();

    apply_i18n(document);

    // Restore local persistence
    await prefsPromise;
    await Persistence.migrate();
    getElement('feed-list').setAttribute("closedFolders", Prefs.get('ui.closedFolders'));
    getElement('tag-list').style.width = Prefs.get('ui.tagList.width');
    getElement('tag-list').addEventListener(
        'resize-complete', ({target}) =>
            Prefs.set('ui.tagList.width', (/** @type HTMLElement */(target)).style.width));
    getElement('sidebar').style.width = Prefs.get('ui.sidebar.width');
    getElement('sidebar').addEventListener(
        'resize-complete', ({target}) =>
            Prefs.set('ui.sidebar.width', (/** @type HTMLElement */(target)).style.width));
    document.body.classList.toggle('sidebar', !Prefs.get('ui.sidebar.hidden'));

    let contentIframe = await contentIframePromise;
    // Allow first meaningful paint
    if(previewURL !== null) {
        document.body.classList.add("preview");
    }
    document.body.classList.remove("loading");

    Prefs.addObserver('feedview.autoMarkRead', () => gCurrentView._autoMarkRead());
    Prefs.addObserver('feedview.sortUnreadViewOldestFirst', () => {
        if (gCurrentView.query.read === false)
            gCurrentView.refresh();
    });

    Commands.switchViewFilter(Prefs.get('ui.view.filter'));

    Comm.registerObservers({
        'update-status': msg => refreshProgressmeter(msg),
    });
    Comm.broadcast('update-query-status');

    Comm.registerObservers({
        'feedlist-updated': ({feeds}) => updatePreviewMode(feeds),
        'style-updated': () => Commands.applyStyle(),
    });
    // TODO: should update FeedView and feed view title too(?) on title change
    // TODO: loading/error indicators

    Commands.applyStyle();

    // TODO consider moving iframe init to view init
    let doc = contentIframe.contentDocument;
    doc.documentElement.setAttribute('lang', browser.i18n.getUILanguage());

    SplitterModule.init();
    document.getElementById('sidebar-splitter').addEventListener(
        'dblclick', () => Commands.hideSidebar());
    document.getElementById('reveal-sidebar-button').addEventListener(
        'click', () => Commands.revealSidebar());

    ContextMenuModule.init();

    DropdownMenus.build();

    FeedViewHeader.init();

    Shortcuts.init({contentDocument: doc});

    // Initialize event handlers
    document.getElementById('update-button').addEventListener(
        'click', () => Comm.broadcast('update-all'), {passive: true});
    document.getElementById('stop-updating-button').addEventListener(
        'click', () => Comm.broadcast('update-stop'), {passive: true});
    document.getElementById('organize-button').addEventListener(
        'click', () => FeedList.organize(), {passive: true});
    document.getElementById('subscribe-button').addEventListener(
        'click', () => Database.addFeeds({url: previewURL}), {passive: true});

    if(previewURL === null) {
        let db = await Database.init();
        ViewList.init(db);
        FeedList.init(db);
        TagList.init(db);
        ViewList.selectedItem = getElement(Prefs.get('ui.startView') || 'all-items-folder');
        await wait();
        FeedList.rebuild();
    } else {
        // Intentionally do not support subscribing from Private Browsing or containers
        // because doing this without correct fetch setup is a privacy leak
        if(await browser.runtime.getBackgroundPage() === null) {
            console.log("Incognito / container detected, disabling subscription");
            document.body.classList.add('incognito');
            (/** @type {HTMLButtonElement} */(document.getElementById('subscribe-button'))).disabled = true;
        }
        let knownFeeds = await knownFeedsPromise;
        updatePreviewMode(knownFeeds);
        let parsedFeed = await parsedFeedPromise;
        document.title = browser.i18n.getMessage("previewTitle", parsedFeed.title);

        let feed = Object.assign({}, {
            feedID: "PREVIEW",
            feedURL: previewURL,
            title: parsedFeed.title,
            websiteURL: parsedFeed.link ? parsedFeed.link.href : '',
            subtitle: parsedFeed.subtitle ? parsedFeed.subtitle.text : '',
            language: parsedFeed.language,
        });
        if(feed.websiteURL !== '') {
            fetchFaviconAsURL(feed).then(icon => {
                (/** @type HTMLLinkElement */ (document.getElementById('favicon'))).href = icon;
            }).catch(error => {
                console.warn(`Brief failed to fetch favicon for ${previewURL}:`, error);
            });
        }
        let entries = Database._feedToEntries({
            feed,
            parsedFeed,
            now: Date.now(),
        });
        entries.reverse();
        let dbEntries = entries.map(e => Database._entryFromItem(e));
        for(let [i, e] of dbEntries.entries()) {
            e.id = i;
        }

        setCurrentView(new FeedView({
            title: parsedFeed.title,
            feeds: [feed],
            entries: dbEntries,
            filter: 'all',
            mode: 'full',
        }));
    }
}


async function loadContentIframe() {
    let feedview_doc = await fetch('feedview.html');
    let contentIframe = /** @type HTMLIFrameElement */ (getElement('feed-view'));
    contentIframe.setAttribute('srcdoc', await feedview_doc.text());
    await expectedEvent(contentIframe, 'load');
    return contentIframe;
}

function updatePreviewMode(feeds) {
    let previewURL = new URLSearchParams(document.location.search).get("preview");
    let knownURLs = feeds.filter(f => f.hidden === 0).map(f => f.feedURL);
    let isKnown = knownURLs.includes(previewURL);
    document.body.classList.toggle('known-feed', isKnown);
    let disable = isKnown || document.body.classList.contains('incognito');
    (/** @type {HTMLButtonElement} */(document.getElementById('subscribe-button'))).disabled = disable;
}


async function refreshProgressmeter({active, progress}) {
    let element = /** @type HTMLProgressElement */ (getElement('update-progress'));
    element.value = progress;
    if (active) {
        getElement('sidebar-top').dataset.mode = "update";
        element.setAttribute('show', "true"); //TODO: css?
    }
    else {
        getElement('sidebar-top').dataset.mode = "idle";
        element.removeAttribute('show');
    }
}

let Searchbar = {
    init() {
        let searchbar = this.element();
        searchbar.addEventListener('input', () => this.onInput());
        searchbar.addEventListener('blur', () => this.onBlur());
    },

    element() {
        return /** @type HTMLInputElement */ (getElement('searchbar'));
    },

    onInput() {
        let searchbar = this.element();

        if (searchbar.value)
            gCurrentView.titleOverride = browser.i18n.getMessage('searchResults', searchbar.value);
        else
            gCurrentView.titleOverride = '';

        gCurrentView.query.searchString = searchbar.value;
        gCurrentView.refresh();
    },

    onBlur() {
        let searchbar = this.element();
        if (!searchbar.value && gCurrentView.query.searchString) {
            gCurrentView.titleOverride = '';
            gCurrentView.query.searchString = searchbar.value;
            gCurrentView.refresh();
        }
    },
};

let FeedViewHeader = {
    init() {
        Searchbar.init();
        const handlers = {
            'mark-view-read': event => this.markRead(event),
            'headlines-checkbox': () => Commands.switchViewMode('headlines'),
            'full-view-checkbox': () => Commands.switchViewMode('full'),
            'show-all-entries-checkbox': () => Commands.switchViewFilter('all'),
            'filter-unread-checkbox': () => Commands.switchViewFilter('unread'),
            'filter-starred-checkbox': () => Commands.switchViewFilter('starred'),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
    },

    markRead(event) {
        if (event.ctrlKey)
            Commands.markVisibleEntriesRead();
        else
            Commands.markViewRead();
    },
};


/* Supports draggable splitters */
let SplitterModule = {
    _active: null,

    init: function Splitter_init() {
        document.body.addEventListener('mousedown', event => this._trigger(event), {capture: true});
    },

    _trigger: function Splitter__trigger(event) {
        let splitter = event.target;
        if(splitter.nodeName !== 'draggable-splitter')
            return;
        if(event.button !== 0)
            return;
        splitter.addEventListener('mousemove', this);
        splitter.addEventListener('mouseup', this);
        splitter.setCapture(); // Auto-released on mouseup
        let target = splitter.previousElementSibling;
        let offset = event.screenX - target.getBoundingClientRect().right;
        this._active = {splitter, target, offset};
        event.preventDefault();
        event.stopPropagation();
    },

    handleEvent: function Splitter_handleEvent(event) {
        if(this._active === null)
            return;
        let {splitter, target, offset} = this._active;
        switch (event.type) {
            case 'mouseup':
                splitter.removeEventListener('mousemove', this);
                splitter.removeEventListener('mouseup', this);
                this._active = null;
                // Fallthrough for the final update
            case 'mousemove':
                {
                    let current_offset = event.screenX - target.getBoundingClientRect().right;
                    target.style.width = (target.offsetWidth + (current_offset - offset)) + 'px';
                }
                break;
        }
        event.stopPropagation();
        if(event.type === 'mouseup') {
            target.dispatchEvent(new Event('resize-complete'));
        }
    },
};

export let Persistence = {
    async migrate() {
        let data = Prefs.get('pagePersist');
        if(data !== "") {
            data = JSON.parse(data);
            await Promise.all([
                Prefs.set('ui.startView', data.startView),
                Prefs.set('ui.closedFolders', data.closedFolders),
                Prefs.set('ui.tagList.width', data.tagList.width),
                Prefs.set('ui.sidebar.width', data.sidebar.width),
                Prefs.set('ui.sidebar.hidden', data.sidebar.hidden),
                Prefs.set('ui.view.mode', data.view.mode),
                Prefs.set('ui.view.filter', data.view.filter),
            ]);
            await Prefs.reset('pagePersist');
        }
    },
};

export let Shortcuts = {
    init: function Shortcuts_init({contentDocument}) {
        document.addEventListener('keydown', this, {capture: true});
        contentDocument.addEventListener('keydown', this, {capture: true});
    },

    handleEvent: function Shortcuts_handleEvents(event) {
        let target = event.target;
        let isInput = target.nodeName === 'input' || target.nodeName === 'textarea';
        if(isInput || target.isContentEditable)
            return;
        let description = (
            (event.ctrlKey ? 'Ctrl+' : '') +
            (event.metaKey ? 'Meta+' : '') +
            (event.altKey ? 'Alt+' : '') +
            (event.shiftKey ? 'Shift+' : '') +
            event.key
        );

        switch(description) {
            case 'j': gCurrentView.selectNextEntry(); break;
            case 'k': gCurrentView.selectPrevEntry(); break;
            case 'u': gCurrentView.scrollDownByScreen(); break;
            case 'i': gCurrentView.scrollUpByScreen(); break;

            case 'm': Commands.toggleSelectedEntryRead(); break;
            case 'n': Commands.markVisibleEntriesRead(); break;
            case 'Alt+n': Commands.markViewRead(); break;
            case 't': Commands.deleteOrRestoreSelectedEntry(); break;
            case 'b': Commands.toggleSelectedEntryStarred(); break;
            case 'h': Commands.toggleSelectedEntryCollapsed(); break;
            case 'Enter': Commands.openSelectedEntryLink(); break;

            case 'f': Commands.switchViewMode('headlines'); break;
            case 'g': Commands.switchViewMode('full'); break;
            case 'a': Commands.switchViewFilter('all'); break;
            case 's': Commands.switchViewFilter('starred'); break;
            case 'd': Commands.switchViewFilter('unread'); break;
            case '/': getElement('searchbar').focus(); break;

            case 'Shift+?': Commands.displayShortcuts(); break;

            // Space and Shift+Space behave differently only in full view
            case ' ':
            case 'Shift+ ':
                if(!Prefs.get('assumeStandardKeys') || gCurrentView.headlinesView)
                    return;
                if(event.shiftKey)
                    gCurrentView.selectPrevEntry();
                else
                    gCurrentView.selectNextEntry();
                break;
            default: return;
        }
        event.preventDefault();
        event.stopPropagation();
    },
};


// ===== Init =====
// ES6 modules are executed after DOM parsing is complete by default
init();

// Debugging hooks
// @ts-ignore
window.Comm = Comm;
// @ts-ignore
window.Database = Database;
// @ts-ignore
window.Prefs = Prefs;
