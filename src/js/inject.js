import config from 'config';
import FileSaver from 'file-saver';
import Clipboard from 'clipboard';
import { unescape } from 'lodash/string';
import Log from './util/logger';
import UsernamesTemplates from './util/username_templates';
import wc from './util/webcrack';

const SETTINGS = $('[data-btd-settings]').data('btd-settings');
window.BTD = {};

if (SETTINGS.no_tco) {
  const dummyEl = document.createElement('span');
  const originalCreateUrlAnchor = TD.util.createUrlAnchor;

  TD.util.createUrlAnchor = (e) => {
    let result = originalCreateUrlAnchor(e);
    // this never touches the final DOM ever so it's fine
    dummyEl.innerHTML = result;
    const anchor = dummyEl.querySelector('a');

    if (anchor) {
      anchor.href = anchor.dataset.fullUrl;
      result = anchor.outerHTML;
    }

    return result;
  };
}

const getMediaParts = (chirp, url) => {
  return {
    fileExtension: url.replace(/:[a-z]+$/, '').split('.').pop(),
    fileName: url.split('/').pop().split('.')[0],
    postedUser: (chirp.retweetedStatus ? chirp.retweetedStatus.user.screenName : chirp.user.screenName),
  };
};

const getChirpFromKey = (key, colKey) => {
  const column = TD.controller.columnManager.get(colKey);

  if (!column) {
    return null;
  }

  const chirpsArray = [];
  Object.keys(column.updateIndex).forEach((updateKey) => {
    const c = column.updateIndex[updateKey];
    if (c) {
      chirpsArray.push(c);
    }

    if (c && c.retweetedStatus) {
      chirpsArray.push(c.retweetedStatus);
    }

    if (c && c.quotedTweet) {
      chirpsArray.push(c.quotedTweet);
    }

    if (c && c.messages) {
      chirpsArray.push(...c.messages);
    }

    if (c && c.targetTweet) {
      chirpsArray.push(c.targetTweet);
    }
  });

  if (column.detailViewComponent) {
    if (column.detailViewComponent.chirp) {
      chirpsArray.push(column.detailViewComponent.chirp);
    }

    if (column.detailViewComponent.mainChirp) {
      chirpsArray.push(column.detailViewComponent.mainChirp);
    }

    if (column.detailViewComponent.repliesTo && column.detailViewComponent.repliesTo.repliesTo) {
      chirpsArray.push(...column.detailViewComponent.repliesTo.repliesTo);
    }

    if (column.detailViewComponent.replies && column.detailViewComponent.replies.replies) {
      chirpsArray.push(...column.detailViewComponent.replies.replies);
    }
  }

  const chirp = chirpsArray.find(c => c.id === String(key));

  if (!chirp) {
    Log(`did not find chirp ${key} within ${colKey}`);
    return null;
  }

  return chirp;
};

/**
 * Takes a node and fetches the chirp associated with it (useful for debugging)
 */
const getChirpFromElement = (element) => {
  const chirpElm = element.closest('[data-key]');
  if (!chirpElm) {
    throw new Error('Not a chirp');
  }

  const chirpKey = chirpElm.getAttribute('data-key');

  let col = chirpElm.closest('[data-column]');
  if (!col) {
    col = document.querySelector(`[data-column] [data-key="${chirpKey}"]`);
    if (!col || !col.parentNode) {
      throw new Error('Chirp has no column');
    } else {
      col = col.parentNode;
    }
  }

  const colKey = col.getAttribute('data-column');
  const chirp = getChirpFromKey(chirpKey, colKey);
  chirp._btd = {
    chirpKey,
    columnKey: colKey,
  };
  return chirp;
};

if (config.get('Client.debug')) {
  window.BTD.debug = {
    wc,
    getChirpFromElement,
    getChirpFromKey,
    findMustache: content => Object.keys(TD.mustaches).filter(i => TD.mustaches[i].toLowerCase().includes(content.toLowerCase())),
  };
}

/**
 * Send messages to the content window with BTDC_ prefix
 */
const proxyEvent = (name, detail = {}) => {
  name = `BTDC_${name}`;
  let cache = [];
  detail = JSON.stringify(detail, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (cache.indexOf(val) !== -1 && !val.screenName) {
        return null;
      }
      cache.push(val);
    }

    return val;
  });
  cache = null;
  window.postMessage({ name, detail }, 'https://tweetdeck.twitter.com');
};

const decorateChirp = (chirp) => {
  if (!chirp) {
    return undefined;
  }

  chirp.chirpType = chirp.chirpType;
  chirp.action = chirp.action;
  return chirp;
};

TD.services.TwitterStatus.prototype.getOGContext = function getOGContext() {
  const repliers = this.getReplyingToUsers() || [];
  const replyingToThemselves = this.user.screenName === this.inReplyToScreenName;

  if (repliers.length === 0 || (replyingToThemselves && repliers.length === 1)) {
    return '';
  }

  const filtered = repliers.filter((user) => {
    // When user are replying to themselves are replying to ppl as well (them + other ppl)
    if (replyingToThemselves && repliers.length > 1) {
      return user.screenName !== this.user.screenName;
    }

    return true;
  }).filter((user) => {
    const str = `<a href="https://twitter.com/${user.screenName}/"`;

    return this.htmlText.indexOf(str) !== 0;
  });

  return filtered.map(user => TD.ui.template.render('text/profile_link', { user })).concat('').join(' ');
};

if (SETTINGS.collapse_columns) {
  if (!window.localStorage.getItem('btd_collapsed_columns')) {
    window.localStorage.setItem('btd_collapsed_columns', JSON.stringify({}));
  }
}

// make it so we can use custom column header icons
TD.mustaches['column/column_header.mustache'] = TD.mustaches['column/column_header.mustache']
  // wrap everyting with an ul
  .replace('{{/withEditableTitle}}', '{{/withEditableTitle}} <ul class="btd-column-buttons">')
  .replace('{{/isTemporary}} </header>', '{{/isTemporary}} </ul> </header>')
  // shove in buttons we care about
  // wrap all the <a>s with <li>s
  .replace(/<\/i> <\/a>/g, '</i> </a> </li>')
  .replace(/<a class="js-action-header-button/g, '<li> <a class="js-action-header-button');

TD.mustaches['column/column_header.mustache'] = TD.mustaches['column/column_header.mustache']
  .replace(
    '{{/withMarkAllRead}}  {{^isTemporary}}',
    `{{/withMarkAllRead}}  {{^isTemporary}}
        ${SETTINGS.clear_column_action ? `
        <li>
          <a class="js-action-header-button column-header-link btd-clear-column-link" href="#" data-action="clear">
            <i class="icon icon-clear-timeline"></i>
          </a>
        </li>` : ''}
        ${SETTINGS.collapse_columns ? `
        <li>
          <a class="js-action-header-button column-header-link btd-toggle-collapse-column-link" href="#" data-action="toggle-collapse-column">
            <i class="icon icon-minus"></i>
          </a>
        </li>` : ''}`,
  );

TD.old_mustaches = Object.assign({}, TD.mustaches);


TD.globalRenderOptions.btd = {
  // Use with
  // {{#btd.usernameFromURL}}myProfileURL{{/btd.usernameFromURL}}
  usernameFromURL: function usernameFromURL() {
    return function what(input, render) {
      // I don't want this function to break horribly the day Twitter closes this issue
      // https://github.com/twitter/hogan.js/issues/222#issuecomment-106101791
      const val = render ? render(input) : Hogan.compile(input).render(this);

      return val.match(/https:\/\/(?:www.|)twitter.com\/(?:@|)([A-Za-z0-9_]+)/) && val.match(/https:\/\/(?:www.|)twitter.com\/(?:@|)([A-Za-z0-9_]+)/)[1];
    };
  },
};

if (SETTINGS.regex_filter) {
  TD.vo.Filter.prototype._testString = function _testString(e) {
    const regex = new RegExp(this.value, 'g');
    if (!e || !this.value) {
      return !0;
    }
    if (this.exact) {
      if (e === this.value) {
        return this.positive;
      }
      if (this.fuzzy && `@${e}` === this.value) {
        return this.positive;
      }
    } else if (e.match(regex) && this.type === 'phrase') {
      return this.positive;
    } else if (e.indexOf(this.value) !== -1) {
      return this.positive;
    }
    return !this.positive;
  };
}

// Embed custom mustaches.
TD.mustaches['btd/download_filename_format.mustache'] = SETTINGS.download_filename_format;

// Call the OG reply stuff
if (SETTINGS.old_replies) {
  // In single tweets
  TD.mustaches['status/tweet_single.mustache'] = TD.mustaches['status/tweet_single.mustache'].replace('lang="{{lang}}">{{{htmlText}}}</p>', 'lang="{{lang}}">{{#getMainTweet}}{{{getOGContext}}}{{/getMainTweet}}{{{htmlText}}}</p>');
  // In detailed tweets
  TD.mustaches['status/tweet_detail.mustache'] = TD.mustaches['status/tweet_detail.mustache'].replace('lang="{{lang}}">{{{htmlText}}}</p>', 'lang="{{lang}}">{{#getMainTweet}}{{{getOGContext}}}{{/getMainTweet}}{{{htmlText}}}</p>');
  // In quote tweets
  TD.mustaches['status/quoted_tweet.mustache'] = TD.mustaches['status/quoted_tweet.mustache'].replace('with-linebreaks">{{{htmlText}}}', 'with-linebreaks">{{#getMainTweet}}{{{getOGContext}}}{{/getMainTweet}}{{{htmlText}}}');
}

// Re-add the RT/like indicator on detailed tweet
TD.mustaches['status/tweet_detail.mustache'] = TD.mustaches['status/tweet_detail.mustache'].replace('</footer> {{/getMainTweet}}', '</footer> {{/getMainTweet}} <i class="sprite tweet-dogear"></i>');
// Re-adds the RT/Like indicators on single tweets
TD.mustaches['status/tweet_single.mustache'] = TD.mustaches['status/tweet_single.mustache'].replace('{{>status/tweet_single_footer}} </div>', '{{>status/tweet_single_footer}} <i class="sprite tweet-dogear"></i> </div>');

if (SETTINGS.old_replies) {
  TD.mustaches['status/tweet_detail.mustache'] = TD.mustaches['status/tweet_detail.mustache'].replace('lang="{{lang}}">{{{htmlText}}}</p>', 'lang="{{lang}}">{{#getMainTweet}}{{{getOGContext}}}{{/getMainTweet}}{{{htmlText}}}</p>');
}

if (SETTINGS.old_replies) {
  TD.mustaches['status/quoted_tweet.mustache'] = TD.mustaches['status/quoted_tweet.mustache'].replace('with-linebreaks">{{{htmlText}}}', 'with-linebreaks">{{#getMainTweet}}{{{getOGContext}}}{{/getMainTweet}}{{{htmlText}}}');
}

// Inject items into the interaction bar
if (SETTINGS.hotlink_item || SETTINGS.download_item) {
  TD.mustaches['status/tweet_single_actions.mustache'] = TD.mustaches['status/tweet_single_actions.mustache']
    .replace(
      '{{_i}}Like{{/i}} </span> </a> </li>',
      `{{_i}}Like{{/i}} </span> </a> </li>
           {{#tweet.entities.media.length}}
           ${SETTINGS.hotlink_item ? `
           <li class="tweet-action-item btd-tweet-action-item pull-left margin-r--13 margin-l--1">
             <a class="js-show-tip tweet-action btd-tweet-action btd-clipboard position-rel" href="#" 
               data-btd-action="hotlink-media" rel="hotlink" title="Copy links to media"> 
               <i class="js-icon-attachment icon icon-attachment txt-center"></i>
               <span class="is-vishidden"> {{_i}}Copy links to media{{/i}} </span>
             </a>
           </li>` : ''}
           ${SETTINGS.download_item ? `
           <li class="tweet-action-item btd-tweet-action-item pull-left margin-r--13 margin-l--1">
             <a class="js-show-tip tweet-action btd-tweet-action position-rel" href="#" 
               data-btd-action="download-media" rel="download" title="Download media"> 
               <i class="js-icon icon icon-download txt-center"></i>
               <span class="is-vishidden"> {{_i}}Download media{{/i}} </span>
             </a>
           </li>` : ''}
           {{/tweet.entities.media.length}}`,
    );
  TD.mustaches['status/tweet_detail_actions.mustache'] = TD.mustaches['status/tweet_detail_actions.mustache']
    .replace(
      '{{_i}}Like{{/i}} </span> </a> {{/account}} </li>',
      `{{_i}}Like{{/i}} </span> </a> {{/account}} </li>
           {{#getMainTweet}}{{#entities.media.length}}
           ${SETTINGS.hotlink_item ? `
           <li class="tweet-detail-action-item btd-tweet-detail-action-item">
             <a class="js-show-tip tweet-detail-action btd-tweet-detail-action btd-clipboard position-rel" href="#"
               data-btd-action="hotlink-media" rel="hotlink" title="Copy links to media">
               <i class="js-icon-attachment icon icon-attachment txt-center"></i>
               <span class="is-vishidden"> {{_i}}Copy links to media{{/i}} </span>
             </a>
           </li>` : ''}
           ${SETTINGS.download_item ? `
           <li class="tweet-detail-action-item btd-tweet-detail-action-item">
             <a class="js-show-tip tweet-detail-action btd-tweet-detail-action position-rel" href="#"
               data-btd-action="download-media" rel="download" title="Download media">
               <i class="js-icon icon icon-download txt-center"></i>
               <span class="is-vishidden"> {{_i}}Download media{{/i}} </span>
             </a>
           </li>` : ''}
           {{/entities.media.length}}{{/getMainTweet}}`,
    );
}

// Adds the Favstar.fm item in menus and adds mute action for each hashtag
TD.mustaches['menus/actions.mustache'] = TD.mustaches['menus/actions.mustache'].replace('{{/isOwnChirp}} {{/chirp}} </ul>', `
      ${SETTINGS.edit_item ? `  
        <li class="is-selectable">
          <a href="#" data-btd-action="edit-tweet">{{_i}}Edit{{/i}}</a>
        </li>
        ` : ''}
        {{/isOwnChirp}}
        ${SETTINGS.mute_source ? `<li class="is-selectable">
          <a href="#" data-btd-action="mute-source" data-btd-source="{{sourceNoHTML}}">Mute "{{sourceNoHTML}}"</a>
        </li>` : ''}
        ${SETTINGS.mute_hashtags ? `{{#entities.hashtags}}
          <li class="is-selectable">
            <a href="#" data-btd-action="mute-hashtag" data-btd-hashtag="{{text}}">Mute #{{text}}</a>
          </li>
        {{/entities.hashtags}}` : ''}
        ${SETTINGS.favstar_item ? `<li class="drp-h-divider"></li>
        <li class="btd-action-menu-item is-selectable"><a href="https://favstar.fm/users/{{user.screenName}}/status/{{chirp.id}}" target="_blank" data-action="favstar">{{_i}}Show on Favstar{{/i}}</a></li>` : ''}
      {{/chirp}}
      </ul>
    `);

UsernamesTemplates(TD.mustaches, SETTINGS.nm_disp);

let bannerID = 1;
const postMessagesListeners = {
  BTDC_getOpenModalTweetHTML: (ev, data) => {
    const { tweetKey, colKey, modalHtml } = data;

    const chirp = getChirpFromKey(tweetKey, colKey);

    if (!chirp) {
      return;
    }

    let markup;

    if (chirp.renderInMediaGallery) {
      markup = chirp.renderInMediaGallery();
    } else if (chirp.targetTweet) {
      markup = chirp.targetTweet.renderInMediaGallery();
    }

    proxyEvent('gotMediaGalleryChirpHTML', {
      markup,
      chirp: decorateChirp(chirp),
      modalHtml,
      colKey,
    });
  },
  BTDC_getChirpFromColumn: (ev, data) => {
    const { chirpKey, colKey } = data;
    const chirp = getChirpFromKey(chirpKey, colKey);

    if (!chirp) {
      return;
    }

    proxyEvent('gotChirpForColumn', { chirp: decorateChirp(chirp), colKey });
  },
  BTDC_likeChirp: (ev, data) => {
    const { chirpKey, colKey } = data;
    const chirp = getChirpFromKey(chirpKey, colKey);

    if (!chirp) {
      return;
    }

    chirp.favorite();
  },
  BTDC_retweetChirp: (ev, data) => {
    const { chirpKey, colKey } = data;
    const chirp = getChirpFromKey(chirpKey, colKey);

    if (!chirp) {
      return;
    }

    chirp.retweet();
  },
  BTDC_renderInstagramEmbed: () => {
    instgrm.Embeds.process();
  },
  BTDC_showTDBanner: (ev, data) => {
    const { banner } = data;
    bannerID += 1;

    $(document).trigger('dataMessage', {
      message: {
        id: bannerID,
        text: TD.i(banner.text),
        colors: {
          background: banner.bg || '#b2d5ed',
          foreground: banner.fg || '#555',
        },
        actions: [{
          id: `btd-banner-${bannerID}`,
          action: banner.action || 'url-ext',
          label: TD.i(banner.label),
          url: banner.url,
          event: banner.event ? banner.event : undefined,
        }],
      },
    });
  },
};

const followStatus = (client, targetUserId) => {
  return new Promise((resolve) => {
    client.showFriendship(client.oauth.account.state.userId, targetUserId, null, (result) => {
      return resolve({
        id: client.oauth.account.state.userId,
        following: result.relationship.target.followed_by,
      });
    });
  });
};

const checkBTDFollowing = () => {
  if (window.localStorage.getItem('btd_disable_prompt_follow_twitter') || SETTINGS.need_update_banner) {
    return;
  }

  const BTD_ID = '4664726178';

  const followingPromises = TD.controller.clients.getClientsByService('twitter').map((client) => {
    return followStatus(client, BTD_ID);
  });

  Promise.all(followingPromises).then((values) => {
    window.localStorage.setItem('btd_disable_prompt_follow_twitter', true);

    const showBanner = values.every(user => !user.following);

    if (!showBanner) {
      return;
    }

    postMessagesListeners.BTDC_showTDBanner({}, {
      banner: {
        text: 'Do you want to follow Better TweetDeck on Twitter for news, support and tips?',
        action: 'trigger-event',
        event: {
          type: 'openBtdProfile',
        },
        label: 'Sure!',
        bg: '#3daafb',
        fg: '#07214c',
      },
    });
  });

  // Promise.all(followingPromises).then(() => {}).catch(() => {
  //   window.localStorage.setItem('btd_disable_prompt_follow_twitter', true);
  //   postMessagesListeners.BTDC_showTDBanner({}, {
  //     banner: {
  //       text: 'Do you want to follow Better TweetDeck on Twitter for news, support and tips?',
  //       action: 'trigger-event',
  //       event: {
  //         type: 'openBtdProfile',
  //       },
  //       label: 'Sure!',
  //       bg: '#3daafb',
  //       fg: '#07214c',
  //     },
  //   });
  // });
};

window.addEventListener('message', (ev) => {
  if (ev.origin.indexOf('tweetdeck.') === -1) {
    return false;
  }

  if (!ev.data.name || !ev.data.name.startsWith('BTDC_') || !postMessagesListeners[ev.data.name]) {
    return false;
  }

  return postMessagesListeners[ev.data.name](ev, ev.data.detail);
});

const switchThemeClass = () => {
  document.body.dataset.btdtheme = TD.settings.getTheme();
};

const handleInsertedNode = (element) => {
  // If the target of the event contains mediatable then we are inside the media modal
  if (element.classList && element.classList.contains('js-mediatable')) {
    const chirpKey = element.querySelector('[data-key]').getAttribute('data-key');
    const chirpKeyEl = document.querySelector(`[data-column] [data-key="${chirpKey}"]`);
    const colKey = chirpKeyEl && chirpKeyEl.closest('[data-column]').getAttribute('data-column');

    if (!colKey) {
      return;
    }

    const chirp = getChirpFromKey(chirpKey, colKey);

    if (!chirp) {
      return;
    }

    proxyEvent('gotChirpInMediaModal', { chirp: decorateChirp(chirp) });
    return;
  }

  if (!element.hasAttribute || !element.hasAttribute('data-key')) {
    return;
  }

  const chirpKey = element.getAttribute('data-key');
  const colKey = element.closest('.js-column').getAttribute('data-column');

  const chirp = getChirpFromKey(chirpKey, colKey);

  if (!chirp) {
    return;
  }

  proxyEvent('gotChirpForColumn', { chirp: decorateChirp(chirp), colKey });
};

const observer = new MutationObserver(mutations => mutations.forEach((mutation) => {
  [...mutation.addedNodes].forEach(handleInsertedNode);
}));
observer.observe(document, { subtree: true, childList: true });

// TD Events
$(document).on('dataColumns', (ev, data) => {
  const cols = data.columns.filter(col => col.model.state.settings).map(col => ({
    id: col.model.privateState.key,
    mediaSize: col.model.state.settings.media_preview_size,
  }));

  proxyEvent('columnsChanged', cols);
});

$(document).on('uiToggleTheme', switchThemeClass);

// Will ensure we keep the media preview size value even when the user changes it
$(document).on('uiColumnUpdateMediaPreview', (ev, data) => {
  const id = ev.target.closest('.js-column').getAttribute('data-column');

  proxyEvent('columnMediaSizeUpdated', { id, size: data.value });
});

// We wait for the loading of the columns and we get all the media preview size
$(document).one('dataColumnsLoaded', () => {
  proxyEvent('ready');

  // We delete the callback for the timestamp task so the content script can do it itself
  if (SETTINGS.ts !== 'relative') {
    const tasks = Object.keys(TD.controller.scheduler._tasks).map(key => TD.controller.scheduler._tasks[key]);
    const refreshTimestampsTask = tasks.find(t => t.period === 1e3 * 30);

    if (refreshTimestampsTask) {
      TD.controller.scheduler.removePeriodicTask(refreshTimestampsTask.id);
    }
  }

  $('.js-column').each((i, el) => {
    let size = TD.storage.columnController.get($(el).data('column')).getMediaPreviewSize();

    if (!size) {
      size = 'medium';
    }

    $(el).attr('data-media-size', size);
  });

  // collapse all the columns that need to be.
  const collapsedColumns = window.localStorage.getItem('btd_collapsed_columns');

  if (!collapsedColumns) {
    window.localStorage.setItem('btd_collapsed_columns', JSON.stringify({}));
  } else {
    const columnSettings = JSON.parse(collapsedColumns);
    Object.keys(columnSettings).map((key) => {
      const column = TD.controller.columnManager.getByApiid(key);
      column._btd.toggleCollapse(!(columnSettings[key] && column));
      return column;
    });
  }

  switchThemeClass();
  setTimeout(checkBTDFollowing, 2000);
});

// Adds search column to the beginning instead of the end, and resets search input for convenience
$(document).on('uiSearchNoTemporaryColumn', (e, data) => {
  if (data.query && data.searchScope !== 'users' && !data.columnKey) {
    if (SETTINGS.make_search_columns_first) {
      const order = TD.controller.columnManager._columnOrder;

      if (order.length > 1) {
        const columnKey = order[order.length - 1];

        order.splice(order.length - 1, 1);
        order.splice(1, 0, columnKey);
        TD.controller.columnManager.move(columnKey, 'left'); // syncs new column order & scrolls to the column
      }
    }

    $('.js-app-search-input').val('');
    $('.js-perform-search').blur();
  }
});

const closeCustomModal = () => {
  $('#open-modal').css('display', 'none');
  $('#open-modal').empty();
};

$(document).keydown((ev) => {
  if ($('#open-modal [btd-custom-modal]').length && ev.keyCode === 27) {
    closeCustomModal();
  }
});

/*
  This snippet is essentially the same as being in the Twitter longer tweets test, for TweetDeck
  The Tweet length counter is fixed by tricking TweetDeck into counting up to 140 characters, twice, so you'll see 140
  instead of 280 in the counter but going over 140 will give you another set of 140 characters.

  modified, from: https://gist.github.com/Zemnmez/ffb5449d873d5407c7172534b762ae46/
*/
let moreTweetsEnabled = false;
const noop = () => {};

const twoEightZero = () => {
  if (SETTINGS.two_eight_zero_chars && !moreTweetsEnabled) {
    TD.services.TwitterClient.prototype.OGTwitterCall = TD.services.TwitterClient.prototype.makeTwitterCall;
    TD.services.TwitterClient.prototype.makeTwitterCall = function makeTwitterCall(path, t, method, n, s, r, o) {
      if (path.endsWith('statuses/update.json')) {
        s = s || noop;
        r = r || noop;

        const a = this.request(path, {
          method,
          params: Object.assign(t, {
            weighted_character_count: !0,
          }),
          processor: n,
          feedType: o,
        });
        a.addCallbacks((_e) => {
          s(_e.data);
        }, (_e) => {
          r(_e.req, '', _e.msg, _e.req.errors);
        });
        return a;
      }
      return this.OGTwitterCall(path, t, method, n, s, r, o);
    };
    window.twttrTxt = Object.assign({}, window.twttr.txt, {
      isInvalidTweet() {
        return !1;
      },
      getTweetLength(x) {
        // eslint-disable-next-line prefer-rest-params
        x = window.twttr.txt.getTweetLength.apply(this, arguments);
        return x <= 140 ? x : x - 140;
      },
    });
    moreTweetsEnabled = true;
  }
};

if (SETTINGS.two_eight_zero_chars) {
  $(document).one('uiDockedComposeTweet', twoEightZero);
  $(document).one('uiComposeTweet', twoEightZero);
}

$(document).on('openBtdSettings', (ev, data) => {
  window.open(data.url);
});

$(document).on('openBtdProfile', () => {
  $(document).trigger('uiShowProfile', {
    id: 'BetterTDeck',
  });
});

document.addEventListener('paste', (ev) => {
  if (ev.clipboardData) {
    const items = ev.clipboardData.items;

    if (!items) {
      return;
    }

    const files = [];

    [...items].forEach((item) => {
      if (item.type.indexOf('image') < 0) {
        return;
      }
      const blob = item.getAsFile();

      files.push(blob);
    });

    if (files.length === 0) {
      return;
    }

    const canPopout = $('.js-inline-compose-pop, .js-reply-popout').length > 0 && !$('.js-app-content').hasClass('is-open');

    if (canPopout) {
      $('.js-inline-compose-pop, .js-reply-popout').first().trigger('click');
      setTimeout(() => {
        $(document).trigger('uiFilesAdded', {
          files,
        });
      }, 0);
      return;
    }

    $(document).trigger('uiFilesAdded', {
      files,
    });
  }
});

const handleGifClick = (ev) => {
  ev.preventDefault();
  ev.stopPropagation();

  const chirpKey = ev.target.closest('[data-key]').getAttribute('data-key');
  const colKey = ev.target.closest('.js-column').getAttribute('data-column');
  const video = {
    src: ev.target.src,
  };

  const chirp = getChirpFromKey(chirpKey, colKey);

  if (!chirp) {
    return;
  }

  video.height = chirp.entities.media[0].sizes.large.h;
  video.width = chirp.entities.media[0].sizes.large.w;

  video.name = TD.ui.template.render('btd/download_filename_format', getMediaParts(chirp, video.src.replace(/\.mp4$/, '.gif')));

  proxyEvent('clickedOnGif', { tweetKey: chirpKey, colKey, video });
};

$('body').on('click', 'article video.js-media-gif', handleGifClick);

$('body').on('click', '#open-modal', (ev) => {
  const isMediaModal = document.querySelector('.js-modal-panel .js-media-preview-container, .js-modal-panel iframe, .js-modal-panel .btd-embed-container');

  if (!SETTINGS.css.no_bg_modal ||
  !isMediaModal) {
    return;
  }

  if (!ev.target.closest('.med-tray')
   && !ev.target.closest('.mdl-btn-media') && $('a[rel="dismiss"]')[0]
   && !ev.target.closest('.med-tweet')) {
    ev.preventDefault();
    ev.stopPropagation();

    if ($('#open-modal [btd-custom-modal]').length) {
      closeCustomModal();
      return;
    }

    $('a[rel="dismiss"]').click();
  }
});

const findBiggestBitrate = (videos) => {
  return videos.reduce((max, x) => {
    return (x.bitrate || -1) > (max.bitrate || -1) ? x : max;
  });
};

const getMediaFromChirp = (chirp) => {
  const urls = [];

  chirp.entities.media.forEach((item) => {
    switch (item.type) {
      case 'video':
      case 'animated_gif':
        urls.push(findBiggestBitrate(item.video_info.variants).url);
        break;
      case 'photo':
        urls.push(`${item.media_url_https}:orig`);
        break;
      default:
        throw new Error(`unsupported media type: ${item.type}`);
    }
  });

  return urls;
};

const getContextFromChirp = (chirp) => {
  const urls = [];

  if (chirp.quotedTweet && !chirp.quotedTweetMissing) {
    urls.push(...getContextFromChirp(chirp.quotedTweet));
  }

  urls.push(chirp.getChirpURL());
  if (chirp.entities.media.length > 1) {
    urls.push(...(getMediaFromChirp(chirp).slice(1)));
  }

  return urls;
};

// Disable eslint so that we can keep a copy of the clipboard around.
// eslint-disable-next-line
const clipboard = new Clipboard('.btd-clipboard', {
  text: (trigger) => {
    const chirp = getChirpFromElement(trigger);
    switch ($(trigger).attr('rel')) {
      case 'hotlink':
        return getMediaFromChirp(chirp).join('\n');
      default:
        return false;
    }
  },
});

$('body').on('click', '.tweet-action[rel="favorite"], .tweet-detail-action[rel="favorite"]' +
  '.tweet-action[rel="retweet"], .tweet-detail-action[rel="retweet"], ' +
  '[data-btd-action="hotlink-media"], ' +
  '[data-btd-action="download-media"]', (ev) => {
  if (!ev.ctrlKey && !ev.metaKey) {
    return;
  }

  if (!SETTINGS || !SETTINGS.ctrl_changes_interactions.enabled) {
    return;
  }

  ev.preventDefault();

  // todo: find a better way to listen to favorites globally
  // primary candidates are ui*Favorite or TD.services.TwitterStatus.prototype.setFavorite

  const chirp = getChirpFromElement(ev.target);

  const user = chirp.retweetedStatus ? chirp.retweetedStatus.user : chirp.user;

  switch (SETTINGS.ctrl_changes_interactions.mode) {
    case 'prompt':
      $(document).trigger('uiShowFollowFromOptions', { userToFollow: user });
      break;
    case 'owner':
    default:
      if (!user.following) {
        user.follow(chirp.account, null, null, true);
      }
      break;
  }
});

((originalColumn) => {
  TD.vo.Column = class Column extends originalColumn {
    constructor(...args) {
      super(...args);

      const _parent = this;
      this._btd = {
        _parent,
        _isCollapsed: false,
        isCollapsed() {
          return this._isCollapsed || false;
        },
        collapse() {
          if (!SETTINGS.collapse_columns) {
            return;
          }

          const dataBoy = JSON.parse(window.localStorage.getItem('btd_collapsed_columns'));

          if (SETTINGS.collapse_columns_pause) {
            const scroller = this._parent.ui.getChirpScroller();
            if (scroller.scrollTop() === 0) {
              this._parent.ui.pause();
            }
          }

          const columnKey = this._parent.model.privateState.key;
          const theColumn = $(`section.column[data-column="${columnKey}"]`);
          theColumn.addClass('btd-column-collapsed');

          dataBoy[this._parent.model.privateState.apiid] = true;
          this._isCollapsed = true;
          window.localStorage.setItem('btd_collapsed_columns', JSON.stringify(dataBoy));
        },
        uncollapse() {
          if (!SETTINGS.collapse_columns) {
            return;
          }
          const dataBoy = JSON.parse(window.localStorage.getItem('btd_collapsed_columns'));

          if (dataBoy[this._parent.model.privateState.apiid]) {
            if (SETTINGS.uncollapse_columns_unpause) {
              const scroller = this._parent.ui.getChirpScroller();
              if (scroller.scrollTop() !== 0) {
                this._parent.ui.unpause();
              }
            }

            const columnKey = this._parent.model.privateState.key;
            const theColumn = $(`section.column[data-column="${columnKey}"]`);
            theColumn.removeClass('btd-column-collapsed');

            delete dataBoy[this._parent.model.privateState.apiid];
            this._isCollapsed = false;
            window.localStorage.setItem('btd_collapsed_columns', JSON.stringify(dataBoy));
            TD.controller.columnManager.showColumn(columnKey);
          }
        },
        toggleCollapse(state = false) {
          if (this._isCollapsed || state) {
            this.uncollapse();
          } else {
            this.collapse();
          }
        },
      };
    }
  };
})(TD.vo.Column);

$('body').on('click', '#column-navigator .column-nav-item', (ev) => {
  ev.preventDefault();
  if (!SETTINGS.collapse_columns) {
    return;
  }

  const thisNav = $(ev.target.closest('li[data-column]'));
  const columnKey = thisNav.data('column');
  TD.controller.columnManager.get(columnKey)._btd.uncollapse();
});

$('body').on('mousedown', '.column-panel header.column-header .btd-clear-column-link', (ev) => {
  ev.preventDefault();
  if (!SETTINGS.clear_column_action || ev.which !== 1) {
    return;
  }

  const thisColumn = ev.target.closest('[data-column]');
  const columnKey = thisColumn.getAttribute('data-column');
  TD.controller.columnManager.get(columnKey).clear();
});

$('body').on('mousedown', '.column-panel header.column-header .btd-toggle-collapse-column-link', (ev) => {
  ev.preventDefault();
  if (!SETTINGS.collapse_columns || ev.which !== 1) {
    return;
  }

  const thisColumn = ev.target.closest('[data-column]');
  const columnKey = thisColumn.getAttribute('data-column');
  TD.controller.columnManager.get(columnKey)._btd.toggleCollapse();
});

$('body').on('click', '[data-btd-action="download-media"]', (ev) => {
  ev.preventDefault();
  const chirp = getChirpFromElement(ev.target);
  const media = getMediaFromChirp(chirp);

  media.forEach((item) => {
    fetch(item)
      .then(res => res.blob())
      .then((blob) => {
        FileSaver.saveAs(blob, TD.ui.template.render('btd/download_filename_format', getMediaParts(chirp, item)));
      });
  });
});

const getMediaUrlParts = (url) => {
  return {
    originalExtension: url.replace(/:[a-z]+$/, '').split('.').pop(),
    originalFile: url.split('/').pop().split('.')[0],
  };
};

// control characters can't appear in tweets, so we can use them to pad strings out
// source: https://shkspr.mobi/blog/2015/11/twitters-weird-control-character-handling/
const loudencer = (str, start, end) => {
  return str.slice(0, start) + ('\x07').repeat(str.slice(start, end).length) + str.slice(end);
};

$('body').on('click', '[data-btd-action="edit-tweet"]', (ev) => {
  ev.preventDefault();
  const chirp = getChirpFromElement(ev.target);
  const media = getMediaFromChirp(chirp);

  const composeData = {
    type: chirp.chirpType,
    text: chirp.text,
    from: [TD.storage.Account.generateKeyFor('twitter', chirp.creatorAccount.getUserID())],
  };

  // @TODO: this doesn't work in DMs yet because DMs use attachments sometimes, i don't understand
  // @TODO: in what circumstances do we use MESSAGE_THREAD? regular MESSAGE has conversationId
  // @TODO: in what circumstances do we use messageRecipients? no chirps have them.

  if (chirp.chirpType === TD.services.ChirpBase.MESSAGE) {
    composeData.conversationId = chirp.conversationId;
  }

  // == get the original text back
  // if we have media, remove the link from the text
  if (chirp.entities.media.length) {
    const firstMedia = chirp.entities.media[0];
    composeData.text = loudencer(composeData.text, ...firstMedia.indices);
  }

  // remove usernames from tweet
  chirp.entities.user_mentions.forEach((mention) => {
    if (mention.isImplicitMention) {
      composeData.text = loudencer(composeData.text, ...mention.indices);
    }
  });

  // replace quotes in a tweet
  chirp.entities.urls.forEach((url) => {
    if (chirp.isQuoteStatus && !chirp.quotedTweetMissing && url.expanded_url === chirp.quotedTweet.getChirpURL()) {
      composeData.text = loudencer(composeData.text, ...url.indices);
      composeData.quotedTweet = chirp.quotedTweet;
    }
  });

  // make the chirp quieter
  composeData.text = composeData.text.replace(/\u0007/gi, '');

  // expand original urls for tweets
  chirp.entities.urls.forEach((url) => {
    composeData.text = composeData.text.replace(url.url, url.expanded_url);
  });

  // ensure no html entities remain
  composeData.text = unescape(composeData.text);

  // trim in case we picked up any whitespace
  composeData.text = composeData.text.trim();

  // compose in advance because the reply composer doesn't transfer text for reasons unknown
  $(document).trigger('uiComposeTweet', composeData);

  // == handle replies
  if (chirp.inReplyToID) {
    const mainChirp = chirp.getMainTweet();
    composeData.type = 'reply';
    composeData.mentions = chirp.getReplyingToUsers();
    composeData.inReplyTo = {
      id: chirp.id,
      htmlText: mainChirp.htmlText,
      user: {
        screenName: mainChirp.user.screenName,
        name: mainChirp.user.name,
        profileImageURL: mainChirp.user.profileImageURL,
      },
    };

    // == find that user, if at all possible
    const column = TD.controller.columnManager.get(chirp._btd.columnKey);
    const replyEl = column.ui.getChirpById(chirp.inReplyToID);
    if (replyEl.length) {
      composeData.element = replyEl[0];
      const replyChirp = getChirpFromElement(replyEl[0]);
      if (replyChirp) {
        composeData.mentions = replyChirp.getReplyUsers();
        composeData.inReplyTo = {
          id: replyChirp.id,
          htmlText: replyChirp.htmlText,
          user: {
            screenName: replyChirp.user.screenName,
            name: replyChirp.user.name,
            profileImageURL: replyChirp.user.profileImageURL,
          },
        };
      } else {
        Log('reply did not have an element for some reason');
      }
    } else {
      Log('reply did not have an existing chirp in its original column');
    }

    // now that the reply information is filled, we have to push this compose on top of the one with text
    $(document).trigger('uiComposeTweet', composeData);
  }

  // == re-upload all the files we had, if any
  if (media.length) {
    Promise.all(media.map(item =>
      fetch(item)
        .then(res => res.blob())
        .then((blob) => {
          const url = getMediaUrlParts(item);
          const options = {};
          switch (url.originalExtension.toLowerCase()) {
            case 'mp4':
              options.type = 'video/mp4';
              break;
            case 'gif':
              options.type = 'image/gif';
              break;
            default:
              break;
          }
          return new File([blob], `${url.originalFile}.${url.originalExtension}`, options);
        }))).then((gotFiles) => {
      $(document).trigger('uiComposeFilesAdded', { files: gotFiles });
    });
  }

  // send one last compose event, for good luck
  $(document).trigger('uiComposeTweet', composeData);

  // it is now safe to remove the tweet
  chirp.destroy();
});

$('body').on('click', '[data-btd-action="mute-hashtag"]', (ev) => {
  ev.preventDefault();
  const hashtag = $(ev.target).data('btd-hashtag');

  TD.controller.filterManager.addFilter('phrase', `#${hashtag}`);
});

$('body').on('click', '[data-btd-action="mute-source"]', (ev) => {
  ev.preventDefault();
  const source = $(ev.target).data('btd-source');

  TD.controller.filterManager.addFilter('source', source);
});

$('body').on({
  mouseenter: (ev) => {
    if (SETTINGS && !SETTINGS.pause_scroll_on_hover) {
      return;
    }
    const thisColumn = ev.target.closest('[data-column]');
    const columnKey = thisColumn.getAttribute('data-column');
    const column = TD.controller.columnManager.get(columnKey);
    const scroller = column.ui.getChirpScroller();
    if (scroller.scrollTop() === 0) {
      column.ui.pause();
    }
  },
  mouseleave: (ev) => {
    if (SETTINGS && !SETTINGS.pause_scroll_on_hover) {
      return;
    }
    const thisColumn = ev.target.closest('[data-column]');
    const columnKey = thisColumn.getAttribute('data-column');
    const column = TD.controller.columnManager.get(columnKey);
    const scroller = column.ui.getChirpScroller();
    if (scroller.scrollTop() === 1) {
      column.ui.unpause();
    }
  },
}, 'section.column');

const defaultTitle = 'TweetDeck';
const unreadTitle = '[*] TweetDeck';
const countTitle = count => `[${count}] TweetDeck`;

// This event triggers everytime the "read" change of a column changes in TweetDeck
$(document).on('uiReadStateChange uiMessageUnreadCount', (ev, data) => {
  // If we didn't enable the option, we stop here
  if (!SETTINGS || !SETTINGS.update_title_on_notifications) {
    return;
  }

  // We get the "read" flag from the event's payload

  const { read, count } = data;

  if (Number(count) > 0 && document.title === defaultTitle && document.title !== countTitle(count)) {
    document.title = countTitle(count);
  }

  if (read === false && document.title === defaultTitle) {
    document.title = unreadTitle;
  }

  if (document.title !== defaultTitle && $('.is-new, .js-unread-count.is-visible').length === 0) {
    document.title = defaultTitle;
  }
});

const isVisible = (elem) => {
  if (!(elem instanceof Element)) {
    throw Error('not an element');
  }

  const style = getComputedStyle(elem);
  const boundRect = elem.getBoundingClientRect();

  // If a single top/bottom/left/right value is negative then the element is partially out of the window
  const isCompletelyVisible = ['left', 'right', 'top', 'bottom'].every(i => boundRect[i] > 0);

  return style.display !== 'none' &&
        style.visibility === 'visible' && isCompletelyVisible;
};

window.addEventListener('focus', (ev) => {
  // Don't do anything if we don't focus the window
  if (!(ev.target instanceof Window)) {
    return;
  }

  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    return;
  }
  const widget = [
    document.querySelector('textarea.compose-text'),
  ].find(elem => elem && isVisible(elem));
  if (widget) {
    widget.focus();
  }
}, true);
