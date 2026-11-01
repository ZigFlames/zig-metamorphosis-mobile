ZIG METAMORPHOSIS (MOBILE): read me
===================================

This is a web app version of Zig Metamorphosis for iPhone and iPad (Safari).
iPhones and iPads can't install browser add-ons, so this works as a web page
that you can also add to your Home Screen like an app.

> Photosensitivity note: nothing flashes or strobes faster than about once per
> second, but the swirling and drifting effects (Brain Morph most of all) can
> still feel intense. Stop if you feel dizzy or unwell.


HOW TO OPEN IT
--------------
1. Open the web address (link) in Safari on your iPhone or iPad.
2. To make it an app: tap the Share button (the square with an arrow), then
   "Add to Home Screen", then "Add". It gets its own icon called "Zig Morph".
   It opens full screen with no Safari bars, and works offline after the
   first visit.


PLAYING A VIDEO
---------------
* "Choose a video" picks a video from Photos, Files, or the camera.
  The video stays on your device. Nothing is uploaded anywhere.
* Or paste a DIRECT video link (usually ending in .mp4 or .mov) and tap Play.
  Links to pages like YouTube, Instagram or TikTok won't work: they are web
  pages, not video files.
* "Try the demo clip" plays a short test video.

Controls: tap the video to show the controls, and they hide again after
3 seconds. While the video plays, nothing is drawn over it.


THE SIX EFFECTS
---------------
* Metamorphosis Cycle: slowly blends through all the effects.
* Liquid Melt: the picture flows like warm wax.
* Dissolve & Reform: the picture breaks into grains and rebuilds itself.
* Refraction: like looking through moving glass or water.
* Chroma Morph: colours slowly shift and separate.
* Brain Morph: an illusion. Stare at the small dot in the middle while soft
  patterns drift around it (25 seconds by default; the "Stare time" slider
  changes this). The patterns then fade out over about 2 seconds, and the
  real video will seem to move or breathe on its own for a moment.
  Nothing flashes.

The sliders set the strength (Intensity) and the speed (Speed) of the effect.

Quality:
* Battery saver: smoothest on battery, a slightly softer picture.
* Balanced: the default.
* Sharp: crisper, but uses more battery.
The app only works while a video is actually playing on screen. When you
pause, or switch to another app, it stops completely to save battery.


WHY SOME LINKS ONLY GET A "LIGHT" EFFECT
----------------------------------------
Some websites don't let other pages read the pixels of their videos (this
is a web security rule called CORS). With those links, the full effects
can't run. The app tells you when this happens, and then uses a lighter
version: a colour-shifting filter, with Brain Morph still fully working.
For the full effects, save the video to your device and use
"Choose a video" instead.


THINGS TO KNOW ON iPHONE / iPAD
-------------------------------
* Sound: Safari doesn't let videos start with sound by themselves. If the
  video starts muted, tap the speaker button. If it doesn't start at all,
  tap the big "Tap to play" button.
* Full screen: on iPhone, Safari doesn't let web pages go truly full
  screen, so use Add to Home Screen to get a full-screen app. On iPad, the
  full-screen button in the top corner works.
* Links starting with "http://" (no "s") are blocked by Safari on secure
  pages. Use https:// links.
* Very long or 4K/HDR videos from Photos can take a moment to open, and
  HDR videos may look a little flatter than in the Photos app.
* Low Power Mode can make the effects less smooth.
* If you don't use the Home Screen app for a few weeks, Safari may clear its
  offline copy. It downloads again the next time you open it with internet.
* Turn the device sideways for a bigger picture. Both orientations work.


WHAT'S IN THIS FOLDER
---------------------
index.html, app.css, app.js : the app itself
sw.js                       : makes it work offline
manifest.webmanifest, icons/: the Home Screen app name and icon
demo.mp4                    : the demo clip
