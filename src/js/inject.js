import config from 'config';
import { debug } from './util/logger';

let SETTINGS;

// We re-add the Like/RTs indicator on single tweets since TD removed them at some point.
// The only reliable way to do that is to perform a search and replace on the templates themselves, unfortunately
TD.mustaches['status/tweet_single.mustache'] = TD.mustaches['status/tweet_single.mustache'].replace('{{>status/tweet_single_footer}} </div> </div>', '{{>status/tweet_single_footer}} </div> <i class="sprite tweet-dogear"></i></div>');
TD.mustaches['status/tweet_detail.mustache'] = TD.mustaches['status/tweet_detail.mustache'].replace('</footer> {{/getMainTweet}}', '</footer> {{/getMainTweet}} <i class="sprite tweet-dogear"></i>');

/**
 * Returns the chirp (tweet) object when given a key and a column key
 * @param  {String} key      The chirp key
 * @param  {String} colKey   The column key
 * @return [Object]          The chirp
 */
const getChirpFromKey = (key, colKey) => {
  // We try to find the column using its key
  const column = TD.controller.columnManager.get(colKey);

  // If we don't find the column, we can't go further and we return null
  if (!column) {
    return null;
  }

  // We build an array of "potential chirps" that we will scan to find our chirp
  const chirpsArray = [];

  // Every single tweet, messages and whatnot is stored inside the `updateIndex` field on a column
  Object.keys(column.updateIndex).forEach(updateKey => {
    // We get the potential chirp inside the array
    const potentialChirp = column.updateIndex[updateKey];

    // If we found something, we push it in `chirpsArray`
    if (potentialChirp) {
      chirpsArray.push(potentialChirp);
    }

    // If the chirp has a retweetedStatus (= it is actually a retweet), then we add that to the candidate list
    if (potentialChirp && potentialChirp.retweetedStatus) {
      chirpsArray.push(potentialChirp.retweetedStatus);
    }

    // If the chirp has a quotedTweet (= it contains a quoted tweet), then we add that to the candidate list
    if (potentialChirp && potentialChirp.quotedTweet) {
      chirpsArray.push(potentialChirp.quotedTweet);
    }

    // If the chirp has a messages field (= the chirp is actually a messages thread), then we add all of them in the candidate array
    if (potentialChirp && potentialChirp.messages) {
      chirpsArray.push(...potentialChirp.messages);
    }

    // If the chirp has a targetTweet (= chirp is actually an action (like, RT, etc) on a tweet), we add that to the candidate array
    if (potentialChirp && potentialChirp.targetTweet) {
      chirpsArray.push(potentialChirp.targetTweet);
    }
  });

  // If the current column actually has details of a tweet opened, we look inside of that
  if (column.detailViewComponent) {
    // `repliesTo` here designates all the tweet /before/ the detailed tweet in the thread
    if (column.detailViewComponent.repliesTo && column.detailViewComponent.repliesTo.repliesTo) {
      chirpsArray.push(...column.detailViewComponent.repliesTo.repliesTo);
    }

    // `replies` here designates all the tweet /after/ the detailed tweet in the thread
    if (column.detailViewComponent.replies && column.detailViewComponent.replies.replies) {
      chirpsArray.push(...column.detailViewComponent.replies.replies);
    }
  }

  // We have all the possible chirps, now we loop through our candidate and match using the id we were given
  const chirp = chirpsArray.find(c => c.id === String(key));

  // If we don't find anything, output a debug statement
  if (!chirp) {
    debug(`did not find chirp ${key} within ${colKey}`);
    return null;
  }

  return chirp;
};

if (config.get('Client.debug')) {
  /**
   * When given a node in the DOM, tries to look for the corresponding chirp (useful for debug)
   * @param  {DOMElement} element The node we want to inspect
   * @return Object               The chirp we found (or not)
   */
  window._BTDinspectChirp = (element) => {
    // If the node doesn't have a parent with a data-key or a data-column then it doesn't
    // have a chirp
    if (!element.closest('[data-key]') || !element.closest('[data-column]')) {
      throw new Error('Not a chirp');
    }

    const colKey = element.closest('[data-column]').getAttribute('data-column');
    const chirpKey = element.closest('[data-key]').getAttribute('data-key');

    // We simply call getChirpFromKey with the chirp key and the column key
    return getChirpFromKey(chirpKey, colKey);
  };

  window._BTDGetChirp = getChirpFromKey;
}

/**
 * Proxies events to the content script with a 'BTDC_' prefix
 * @param  {String} name        Name of the event
 * @param  {Object} detail      Data attached to the event
 */
const proxyEvent = (name, detail = {}) => {
  // We change the name of our event
  name = `BTDC_${name}`;
  // Here we have to do some custom stringify on the data as it can contain chirps.
  // Since chirps are full of prototypes, it would otherwise trigger circular dependencies.
  //
  // For that, we define a cache
  let cache = [];

  detail = JSON.stringify(detail, (key, val) => {
    // If we encounter an object, we check its present in cache or not
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

    proxyEvent('gotMediaGalleryChirpHTML', { markup, chirp: decorateChirp(chirp), modalHtml, colKey });
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
  BTDC_settingsReady: (ev, data) => {
    const { settings } = data;
    SETTINGS = settings;

    const tasks = TD.controller.scheduler._tasks;
    // We delete the callback for the timestamp task so the content script can do it itself
    if (settings.ts !== 'relative') {
      Object.keys(tasks).forEach((key) => {
        if (tasks[key].period === 30000) {
          tasks[key].callback = () => false;
        }
      });
    }
  },
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

const handleInsertedNode = (ev) => {
  const target = ev.target;
  // If the target of the event contains mediatable then we are inside the media modal
  if (target.classList && target.classList.contains('js-mediatable')) {
    const chirpKey = target.querySelector('[data-key]').getAttribute('data-key');
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

  if (!target.hasAttribute || !target.hasAttribute('data-key')) {
    return;
  }

  const chirpKey = target.getAttribute('data-key');
  const colKey = target.closest('.js-column').getAttribute('data-column');

  let chirp = getChirpFromKey(chirpKey, colKey);

  if (!chirp) {
    return;
  }

  if (chirp._hasAnimatedGif) {
    if (chirp.targetTweet) {
      chirp = chirp.targetTweet;
    }

    const videoEl = $(`[data-key="${chirp.entities.media[0].id}"] video`)[0];

    if (videoEl && videoEl.paused) {
      return;
    }

    if (SETTINGS.stop_gifs) {
      setTimeout(() => {
        if ($(`[data-key="${chirp.entities.media[0].id}"] [rel="pause"]`).length > 0) {
          $(`[data-key="${chirp.entities.media[0].id}"] [rel="pause"]`)[0].click();
        }
      });
    }
  }

  proxyEvent('gotChirpForColumn', { chirp: decorateChirp(chirp), colKey });
};

document.addEventListener('DOMNodeInserted', handleInsertedNode);

$(document).on('uiVisibleChirps', (ev, data) => {
  const { chirpsData, columnKey } = data;
  const isThereGifs = chirpsData.filter(chirp => {
    const hasGif = chirp.chirp && chirp.chirp._hasAnimatedGif;
    const el = chirp.$elem[0];
    const isPaused = el.querySelector('video') && !el.querySelector('video').paused;

    return hasGif && isPaused;
  }).length > 0;

  if (isThereGifs && SETTINGS.stop_gifs) {
    chirpsData.filter(chirp => chirp.chirp._hasAnimatedGif).forEach(c => {
      const videoEl = $(`[data-column="${columnKey}"] [data-key="${c.id}"] video`)[0];

      if (videoEl && videoEl.paused) {
        return;
      }

      setTimeout(() => {
        if ($(`[data-column="${columnKey}"] [data-key="${c.id}"] [rel="pause"]`).length > 0) {
          $(`[data-column="${columnKey}"] [data-key="${c.id}"] [rel="pause"]`)[0].click();
        }
      });
    });
  }
});

// TD Events
$(document).on('dataColumns', (ev, data) => {
  const cols = data.columns.filter(col => col.model.state.settings).map((col) => ({
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

  $('.js-column').each((i, el) => {
    let size = TD.storage.columnController.get($(el).data('column')).getMediaPreviewSize();

    if (!size) {
      size = 'medium';
    }

    $(el).attr('data-media-size', size);
  });

  switchThemeClass();
});

const closeCustomModal = () => {
  $('#open-modal').css('display', 'none');
  $('#open-modal').empty();
};

$(document).keydown((ev) => {
  if ($('#open-modal [btd-custom-modal]').length && ev.keyCode === 27) {
    closeCustomModal();
    return;
  }
});

document.addEventListener('paste', ev => {
  if (ev.clipboardData) {
    const items = ev.clipboardData.items;

    if (!items) {
      return;
    }

    const files = [];

    [...items].forEach(item => {
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
  video.name = `${chirp.user.screenName}-${video.src.split('/').pop().replace('.mp4', '')}`;

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
    return;
  }
});
