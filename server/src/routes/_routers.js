// Central router registry
// Import ALL API routers here

import { authRouter } from "./auth.js";
import { gamesRouter } from "./games.js";
import { notificationsRouter } from "./notifications.js";
import { reviewsRouter } from "./routes.reviews.js";
import { profileRouter } from "./routes.profile.js";
import { reportsRouter } from "./routes.reports.js";
import { gameHostingRouter } from "./routes.gamehosting.js";
import { blogRouter } from "./routes.blog.js";

// Optional / existing routers (uncomment when files exist)
import { friendsRouter } from "./friends.js";
import { moderationRouter } from "./moderation.js";
import { itemsRouter } from "./routes.items.js";
import { statsRouter } from "./routes.stats.js";
import { appealsRouter } from "./routes.appeals.js";
import { storageRouter } from "./routes.storage.js";
import { libraryRouter } from "./routes.library.js";
import { launcherRouter } from "./routes.launcher.js";
import { photonRouter } from "./photon.js";
import { sdkRouter } from "./sdk.js";
import { customLevelsRouter } from "./custom-levels.js";
import { createChatRouter } from "./chat.js";
import { gameEditorRouter } from "./gameeditor.js";
import { changelogRouter } from "./changelog.js";
import { roadmapRouter } from "./roadmap.js";
import { gitInfoRouter } from "./git-info.js";

export {
  authRouter,
  gamesRouter,
  notificationsRouter,
  reviewsRouter,
  profileRouter,
  reportsRouter,
  gameHostingRouter,
  blogRouter,
  friendsRouter,
  moderationRouter,
  itemsRouter,
  statsRouter,
  appealsRouter,
  storageRouter,
  libraryRouter,
  launcherRouter,
  photonRouter,
  sdkRouter,
  customLevelsRouter,
  createChatRouter,
  gameEditorRouter,
  changelogRouter,
  roadmapRouter,
  gitInfoRouter
};
