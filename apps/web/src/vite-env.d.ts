/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_BRANCH__: string;
declare const __APP_BUILD_TIME__: string;
declare const __APP_RECENT_COMMITS__: Array<{
  authorName: string;
  authoredAt: string;
  hash: string;
  shortHash: string;
  subject: string;
}>;
