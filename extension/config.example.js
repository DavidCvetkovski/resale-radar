// install.sh copies this to config.js with your email and a private ntfy topic filled in.
// Changes you make in the add-on's popup are saved in Chrome and take priority over this file.
export const DEFAULTS = {
  enabled: true,
  minSeconds: 45, // random wait between checks, in seconds (30 at the least)
  maxSeconds: 90,
  email: '__EMAIL__',
  ntfyTopic: '__TOPIC__',
  events: [
    {
      name: 'Halloweenfest @ Skatecafe (Sat 31 Oct)',
      url: 'https://www.ticketswap.com/club-tickets/online-pacific-ondergronds-kruispunt-presenteren-halloweenfest-w-amsterdam-junglist-kru-arda-io-cyberfairy777-death-sells-dj-unk-drumsong-dj-ggl-crew-mispricks-plug-and-play-tear-drinker-toff-youth-amsterdam-skatecafe-2026-10-31-CfLVbxJU5PTnzfHNzfVzc',
    },
  ],
};
