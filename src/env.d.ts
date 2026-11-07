/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user: {
      sub: string;
      preferred_username: string;
      name: string;
      picture?: string;
      roles?: string[];
      email?: string;
      graduation_year?: number | null;
    } | null;
  }
}
