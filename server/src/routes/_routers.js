// Central router registry
// Import ALL API routers here

import { authRouter } from "./auth.js";
import { gamesRouter } from "./games.js";
import { notificationsRouter } from "./notifications.js";
import { reviewsRouter } from "./routes.reviews.js";
import { profileRouter } from "./routes.profile.js";
import { reportsRouter } from "./routes.reports.js";
import { gameHostingRouter } from "./routes.gamehosting.js";

// Optional / existing routers (uncomment when files exist)
import { friendsRouter } from "./friends.js";
import { inventoryRouter } from "./inventory.js";
import { marketRouter } from "./market.js";
import { walletRouter } from "./wallet.js";
import { moderationRouter } from "./moderation.js";
import { itemsRouter } from "./routes.items.js";
import { statsRouter } from "./routes.stats.js";
import { appealsRouter } from "./routes.appeals.js";
import { storageRouter } from "./routes.storage.js";
import { libraryRouter } from "./routes.library.js";
import { photonRouter } from "./photon.js";
import { sdkRouter } from "./sdk.js";
import { customLevelsRouter } from "./custom-levels.js";
import { createChatRouter } from "./chat.js";

export {
  authRouter,
  gamesRouter,
  notificationsRouter,
  reviewsRouter,
  profileRouter,
  reportsRouter,
  gameHostingRouter,
  friendsRouter,
  inventoryRouter,
  marketRouter,
  walletRouter,
  moderationRouter,
  itemsRouter,
  statsRouter,
  appealsRouter,
  storageRouter,
  libraryRouter,
  photonRouter,
  sdkRouter,
  customLevelsRouter,
  createChatRouter
};
