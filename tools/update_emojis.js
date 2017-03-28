/*
 * This script will fetch `emoji.json` from the emoji-data repo and output a emojis.js file.
 * The said file will be used for the emoji picker.
 */

const needle = require('needle');
const _ = require('lodash');
const jsEmoji = require('js-emoji');
const Emoji = new jsEmoji.EmojiConvertor();
const fs = require('fs');
Emoji.img_set = 'twitter';

/**
 * Will output the unicode character(s) for a given emoji object
 * @param  [Object] emoji   The emoji object to convert
 * @return [String]         The unicode string corresponding to the emoji
 */
function getUnified(emoji) {
  // Set the replace_mode of Emoji to `unified`
  Emoji.replace_mode = 'unified';

  // Wrap the shortname around colons so we can convert it
  const converted = Emoji.replace_colons(`:${emoji.s}:`);

  // If the emoji is correctly converted, we return it
  if (converted !== `:${emoji.s}:` && !converted.startsWith('<img')) {
    return converted;
  }

  // Otherwise we return null
  return null;
}

// Categories in the picker have to be in a certain order
const catOrder = {
  People: -80,
  Nature: -70,
  Foods: -60,
  Activity: -50,
  Places: -40,
  Objects: -30,
  Symbols: -20,
  Flags: -10,
};

// Some emojis don't have the right category, we fix that here
const getMissingCategory = (shortName) => {
  if (shortName === 'keycap_star') {
    return 'Symbols';
  }

  if (shortName.startsWith('flag-')) {
    return 'Flags';
  }

  return null;
};

needle.get('https://raw.githubusercontent.com/iamcal/emoji-data/master/emoji.json', (err, res) => {
  const emojiArr = JSON.parse(res.body);

  const final = _.chain(emojiArr)
                  .filter(emoji => emoji.category)
                  .sortBy(emoji => emoji.sort_order)
                  .sortBy(emoji => catOrder[emoji.category])
                  .map(emoji => {
                    return {
                      s: emoji.shortName,
                      n: emoji.name,
                      hs: Boolean(emoji.skin_variations),
                      cat: emoji.category || getMissingCategory(emoji.s_name),
                    };
                  })
                  .value();

  const finalForTemplate = final.filter(emoji => getUnified(emoji));
  const outStr = `module.exports = ${JSON.stringify(finalForTemplate)}`;

  fs.writeFileSync('./src/emojis/emojis.js', outStr, 'utf8');
});
