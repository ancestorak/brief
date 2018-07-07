'use strict';

const Brief = {
    // Port for receiving status updates
    _statusPort: null,
    // Latest status
    _status: null,
    // Feeds in known windows
    _windowFeeds: new Map(),

    // No deinit required, we'll be forcefully unloaded anyway
    init: async function() {
        Comm.initMaster();

        browser.runtime.onInstalled.addListener(async ({temporary}) => {
            if(temporary) { // `web-ext run` or equivalent
                Comm.verbose = true;
                const TEST_INDEX = browser.runtime.getURL('/test/index.xhtml');
                let tabs = await browser.tabs.query({url: TEST_INDEX});
                if(tabs.length === 0) {
                    browser.tabs.create({url: TEST_INDEX});
                } else {
                    for(let {id} of tabs) {
                        browser.tabs.reload(id);
                    }
                }
            }
        });

        browser.browserAction.onClicked.addListener(
            () => browser.tabs.create({url: '/ui/brief.xhtml'}));
        browser.browserAction.setBadgeBackgroundColor({color: 'grey'});

        browser.contextMenus.create({
            id: "brief-button-refresh",
            title: browser.i18n.getMessage("briefCtxRefreshFeeds_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-mark-read",
            title: browser.i18n.getMessage("briefCtxMarkFeedsAsRead_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-show-unread",
            type: "checkbox",
            title: browser.i18n.getMessage("briefCtxShowUnreadCounter_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-options",
            title: browser.i18n.getMessage("briefCtxShowOptions_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.onClicked.addListener(info => this.onContext(info));

        await Prefs.init({master: true});

        Prefs.addObserver('showUnreadCounter', () => this._updateUI());
        Comm.registerObservers({
            'feedlist-updated': () => this._updateUI(),
            'entries-updated': debounced(100, () => this._updateUI()),
            'subscribe-get-feeds': ({windowId}) => this._windowFeeds.get(windowId),
            'subscribe-add-feed': ({feed}) => Database.addFeeds(feed).catch(console.error),
        });

        await Database.init();

        await FeedUpdater.init();

        this._updateUI();
        // TODO: first run page

        browser.tabs.onUpdated.addListener((id, change, tab) => {
            if(tab.active === false) {
                return;
            }
            this.queryFeeds({
                tabId: id,
                url: tab.url,
                title: tab.title,
                windowId: tab.windowId,
            });
        });
        browser.tabs.onActivated.addListener((ids) => this.queryFeeds(ids));
        let activeTabs = await browser.tabs.query({active: true});
        for(let tab of activeTabs) {
            this.queryFeeds({
                tabId: tab.id,
                url: tab.url,
                title: tab.title,
                windowId: tab.windowId,
            });
        }
    },

    onContext: function({menuItemId, checked}) {
        switch(menuItemId) {
            case 'brief-button-refresh':
                Comm.broadcast('update-all');
                break;
            case 'brief-button-mark-read':
                Database.query().markRead(true);
                break;
            case 'brief-button-show-unread':
                Prefs.set('showUnreadCounter', checked);
                break;
            case 'brief-button-options':
                browser.runtime.openOptionsPage();
                break;
        }
    },

    // Should match `extensions.webextensions.restrictedDomains` pref
    RESTRICTED_DOMAINS: new Set([
        "accounts-static.cdn.mozilla.net",
        "accounts.firefox.com",
        "addons.cdn.mozilla.net",
        "addons.mozilla.org",
        "api.accounts.firefox.com",
        "content.cdn.mozilla.net",
        "content.cdn.mozilla.net",
        "discovery.addons.mozilla.org",
        "input.mozilla.org",
        "install.mozilla.org",
        "oauth.accounts.firefox.com",
        "profile.accounts.firefox.com",
        "support.mozilla.org",
        "sync.services.mozilla.com",
        "testpilot.firefox.com",
    ]),

    BRIEF_SUBSCRIBE: new RegExp(
        "(chrome://brief/content/brief\\.(xul|xhtml)\\?subscribe=|brief://subscribe/)(.*)"),

    async queryFeeds({tabId, url, title, windowId}) {
        let replies = [[]];
        let matchSubscribe = this.BRIEF_SUBSCRIBE.exec(url);
        if(matchSubscribe) {
            let url = decodeURIComponent(matchSubscribe.pop());
            Database.addFeeds({url});
            browser.tabs.update({url: '/ui/brief.xhtml'});
        }
        let path = null;
        try {
            replies = await browser.tabs.executeScript(tabId, {
                file: '/content_scripts/scan-for-feeds.js',
                runAt: 'document_end',
            });
        } catch(ex) {
            if(ex.message === 'Missing host permission for the tab') {
                // There are a few known cases: about:, restricted (AMO) and feed preview pages
                if(url === undefined) {
                    ({url, title} = await browser.tabs.get(tabId));
                }
                let parsedUrl = new URL(url);
                if(url === undefined || parsedUrl.protocol === 'about:') {
                    // Ok, looks like there's nothing Brief can do
                    // (feeds from AMO cannot be fetched)
                } else if(Brief.RESTRICTED_DOMAINS.has(parsedUrl.host)) {
                    // FIXME: maybe try fetching them as `restricted.domain.com.`?
                } else {
                    // Assume this is a feed preview/subscribe page
                    replies = [[{url, linkTitle: title}]];
                    path = '/icons/brief.svg#pulsing';
                }
            } else {
                throw ex;
            }
        }
        let feeds = replies[0];
        if(feeds.length > 0) {
            browser.pageAction.show(tabId);
            browser.pageAction.setIcon({path, tabId});
        } else {
            browser.pageAction.hide(tabId);
        }
        this._windowFeeds.set(windowId, feeds);
    },

    _updateUI: async function() {
        Ticker.renderExternal();

        let enabled = Prefs.get('showUnreadCounter');
        browser.contextMenus.update('brief-button-show-unread', {checked: enabled});
        if(enabled) {
            let count = await Database.query({
                deleted: 0,
                read: 0,
                includeFeedsExcludedFromGlobalViews: 0,
            }).count();
            let text = "";
            if(count > 0) {
                text = count.toString();
                // We crop the badge manually to leave the least-significant digits
                if (text.length > 4)
                    text = '..' + text.substring(text.length - 3);
            }
            browser.browserAction.setBadgeText({text});
        } else {
            browser.browserAction.setBadgeText({text: ""});
        }
        //TODO: return tooltip
        /*
            _updateStatus: async function Brief__updateStatus() {
                let updated = "";
                let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');

                let lastUpdateTime = this.prefs.getIntPref('update.lastUpdateTime') * 1000;
                let date = new Date(lastUpdateTime);
                let relativeDate = new this.common.RelativeDate(lastUpdateTime);

                let time, pluralForms, form;
                let lang = Brief.window.navigator.language;

                switch (true) {
                    case relativeDate.deltaMinutes === 0:
                        updated = bundle.GetStringFromName('lastUpdated.rightNow');
                        break;

                    case relativeDate.deltaHours === 0:
                        pluralForms = bundle.GetStringFromName('minute.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaMinutes, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaMinutes);
                        break;

                    case relativeDate.deltaHours <= 12:
                        pluralForms = bundle.GetStringFromName('hour.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaHours, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaHours);
                        break;

                    case relativeDate.deltaDaySteps === 0:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.today', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps === 1:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.yesterday', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps < 7:
                        pluralForms = bundle.GetStringFromName('day.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaDays, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaDays);
                        break;

                    case relativeDate.deltaYearSteps === 0:
                        date = date.toLocaleDateString(lang, {month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;

                    default:
                        date = date.toLocaleDateString(lang, {
                            year: 'numeric', month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;
                }

                let rows = [];

                let feeds_query = new Query({
                    deleted: false,
                    read: false,
                    sortOrder: 'library',
                    sortDirection: 'asc'
                })

                let unreadFeeds = await feeds_query.getProperty('feedID', true);

                let noUnreadText = "";
                if(unreadFeeds.length == 0)
                    noUnreadText = bundle.GetStringFromName('noUnreadFeedsTooltip');

                for (let feed of unreadFeeds) {
                    let feedName = Storage.getFeed(feed).title;
                    if(feedName.length > 24)
                        feedName = feedName.substring(0, 24) + "...";

                    let query = new Query({
                        deleted: false,
                        feeds: [feed],
                        read: false
                    })

                    rows.push(query.getEntryCount().then(count => `${count}\t\t${feedName}`));
                }
                rows = await Promise.all(rows);
                let tooltip = `${updated}\n\n${noUnreadText}${rows.join('\n')}`;
            },
         */
        //browser.browserAction.setTitle({title: tooltip});
    },
};

Brief.init();
