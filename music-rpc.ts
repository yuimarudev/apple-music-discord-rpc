#!/usr/bin/env deno run --allow-env --allow-run --allow-net --allow-read --allow-write --allow-ffi --allow-import --unstable-kv
import type { Activity } from "https://deno.land/x/discord_rpc@0.3.2/mod.ts";
import { Client } from "https://deno.land/x/discord_rpc@0.3.2/mod.ts";
import type { } from "https://raw.githubusercontent.com/NextFire/jxa/v0.0.5/run/global.d.ts";
import { run } from "https://raw.githubusercontent.com/NextFire/jxa/v0.0.5/run/mod.ts";
import type { iTunes } from "https://raw.githubusercontent.com/NextFire/jxa/v0.0.5/run/types/core.d.ts";

//#region RPC
class AppleMusicDiscordRPC {
  static readonly CLIENT_IDS: Record<iTunesAppName, string> = {
    iTunes: "979297966739300416",
    Music: "773825528921849856",
  };
  static readonly KV_VERSION = 0;

  private constructor(
    public readonly appName: iTunesAppName,
    public readonly rpc: Client,
    public readonly kv: Deno.Kv,
    public readonly defaultTimeout: number,
    public localArtworksCache: Map<string, Uint8Array | null> = new Map()
  ) {
    const url = Deno.env.get("ARTWORK_SERVER_BASEURL");
    const port = Deno.env.get("ARTWORK_SERVER_PORT");

    if (url && port) {
      Deno.serve({ port: parseInt(port) }, (req) => {
        const id = new URL(req.url).pathname.slice(1);
        const data = localArtworksCache.get(id);

        if (!data) return new Response("Not found", { status: 404 });

        const header = data.slice(0, 8);
        const mimeType = "image/" + (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47 &&
          header[4] === 0x0D && header[5] === 0x0A && header[6] === 0x1A && header[7] === 0x0A ? "png" : header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF ? "jpeg" : header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38 ? "gif" : ((header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2A && header[3] === 0x00) ||
            (header[0] === 0x4D && header[1] === 0x4D && header[2] === 0x00 && header[3] === 0x2A)) ? "tiff" : "bmp");

        return new Response(data, { headers: { "Content-Type": mimeType } });
      });
    }
  }

  async run(): Promise<void> {
    while (true) {
      try {
        await this.setActivityLoop();
      } catch (err) {
        console.error(err);
      }
      console.log("Reconnecting in %dms", this.defaultTimeout);
      await sleep(this.defaultTimeout);
    }
  }

  tryCloseRPC(): void {
    if (this.rpc.ipc) {
      console.log("Attempting to close connection to Discord RPC");
      try {
        this.rpc.close();
      } finally {
        console.log("Connection to Discord RPC closed");
        this.rpc.ipc = undefined;
      }
    }
  }

  async setActivityLoop(): Promise<void> {
    try {
      await this.rpc.connect();
      console.log("Connected to Discord RPC");
      while (true) {
        const timeout = await this.setActivity();
        console.log("Next setActivity in %dms", timeout);
        await sleep(timeout);
      }
    } finally {
      // Ensure the connection is properly closed
      this.tryCloseRPC();
    }
  }

  async setActivity(): Promise<number> {
    const open = await isMusicOpen(this.appName);
    console.log("open:", open);

    if (!open) {
      await this.rpc.clearActivity();
      return this.defaultTimeout;
    }

    const state = await getMusicState(this.appName);
    console.log("state:", state);

    switch (state) {
      case "playing": {
        const props = await getMusicProps(this.appName);
        console.log("props:", props);

        let delta, start, end;
        if (props.duration) {
          delta = (props.duration - props.playerPosition) * 1000;
          end = Math.ceil(Date.now() + delta);
          start = Math.ceil(Date.now() - props.playerPosition * 1000);
        }

        // EVERYTHING must be less than or equal to 128 chars long
        const activity: Activity = {
          // @ts-ignore: "listening to" is allowed in recent Discord versions
          type: 2,
          details: AppleMusicDiscordRPC.truncateString(props.name),
          timestamps: { start, end },
          assets: { large_image: "appicon" },
        };

        if (props.artist) {
          activity.state = AppleMusicDiscordRPC.truncateString(props.artist);
        }

        if (props.album) {
          const infos = await this.cachedTrackExtras(props);
          console.log("infos:", infos);

          activity.assets = {
            large_image: infos.artworkUrl ?? "appicon",
            large_text: AppleMusicDiscordRPC.truncateString(props.album),
          };

          const buttons = [];

          if (infos.iTunesUrl) {
            buttons.push({
              label: "Play on Apple Music",
              url: infos.iTunesUrl,
            });
          }

          const query = encodeURIComponent(
            `artist:${props.artist} track:${props.name}`,
          );
          const spotifyUrl = `https://open.spotify.com/search/${query}?si`;
          if (spotifyUrl.length <= 512) {
            buttons.push({
              label: "Search on Spotify",
              url: spotifyUrl,
            });
          }

          if (buttons.length > 0) {
            activity.buttons = buttons;
          }
        }

        await this.rpc.setActivity(activity);
        return Math.min(
          (delta ?? this.defaultTimeout) + 1000,
          this.defaultTimeout,
        );
      }

      case "paused":
      case "stopped": {
        await this.rpc.clearActivity();
        return this.defaultTimeout;
      }

      default:
        throw new Error(`Unknown state: ${state}`);
    }
  }

  async cachedTrackExtras(props: iTunesProps): Promise<TrackExtras> {
    const { name, artist, album, persistentID } = props;
    const cacheIndex = `${name} ${artist} ${album}`;
    const baseurl = Deno.env.get("ARTWORK_SERVER_BASEURL");

    let infos = (await this.kv.get<TrackExtras>(["extras", cacheIndex])).value;
    let localArtwork = this.localArtworksCache.get(props.persistentID);

    if (!localArtwork && localArtwork !== null && baseurl) {
      localArtwork = await getLocalAlbumArtwork(this.appName);
      this.localArtworksCache.set(props.persistentID, localArtwork);
    }

    if (!infos) {
      const artworkUrl = baseurl + "/" + persistentID;
      infos = await fetchTrackExtras(props);
      infos.artworkUrl = baseurl && localArtwork ? artworkUrl : infos.artworkUrl;

      await this.kv.set(["extras", cacheIndex], infos);
    }

    return infos;
  }

  static async create(defaultTimeout = 15e3): Promise<AppleMusicDiscordRPC> {
    const macOSVersion = await this.getMacOSVersion();
    const appName: iTunesAppName = macOSVersion >= 10.15 ? "Music" : "iTunes";
    const rpc = new Client({ id: this.CLIENT_IDS[appName] });
    const kv = await Deno.openKv(`cache_v${this.KV_VERSION}.sqlite3`);
    return new this(appName, rpc, kv, defaultTimeout);
  }

  static async getMacOSVersion(): Promise<number> {
    const cmd = new Deno.Command("sw_vers", { args: ["-productVersion"] });
    const output = await cmd.output();
    const decoded = new TextDecoder().decode(output.stdout);
    const version = parseFloat(decoded.match(/\d+\.\d+/)![0]);
    return version;
  }

  static truncateString(value: string, maxLength = 128): string {
    return value.length <= maxLength
      ? value
      : `${value.slice(0, maxLength - 3)}...`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToUint8Array(hexString: string) {
  const length = hexString.length;
  const byteArray = new Uint8Array(length / 2);
  for (let i = 0; i < length; i += 2) {
    byteArray[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
  }
  return byteArray;
}

const client = await AppleMusicDiscordRPC.create();
await client.run();
//#endregion

//#region JXA
function isMusicOpen(appName: iTunesAppName): Promise<boolean> {
  return run((appName: iTunesAppName) => {
    return Application("System Events").processes[appName].exists();
  }, appName);
}

function getMusicState(appName: iTunesAppName): Promise<string> {
  return run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return music.playerState();
  }, appName);
}

function getMusicProps(appName: iTunesAppName): Promise<iTunesProps> {
  return run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return {
      ...music.currentTrack().properties(),
      playerPosition: music.playerPosition(),
    };
  }, appName);
}

async function getLocalAlbumArtwork(appName: iTunesAppName): Promise<Uint8Array | null> {
  const rawData: string | undefined = await run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return music.currentTrack().artworks[0].rawData();
  }, appName).catch(_ => void 0);

  if (!rawData) return null;

  return hexToUint8Array(rawData.slice(8, -2));
}
//#endregion

//#region Extras
async function fetchTrackExtras(props: iTunesProps): Promise<TrackExtras> {
  const json = await iTunesSearch(props);

  let result: iTunesSearchResult | undefined;
  if (json && json.resultCount === 1) {
    result = json.results[0];
  } else if (json && json.resultCount > 1) {
    // If there are multiple results, find the right album
    // Use includes as imported songs may format it differently
    // Also put them all to lowercase in case of differing capitalisation
    result = json.results.find(
      (r) =>
        r.collectionName.toLowerCase().includes(props.album.toLowerCase()) &&
        r.trackName.toLowerCase().includes(props.name.toLowerCase()),
    );
  } else if (props.album.match(/\(.*\)$/)) {
    // If there are no results, try to remove the part
    // of the album name in parentheses (e.g. "Album (Deluxe Edition)")
    return await fetchTrackExtras({
      ...props,
      album: props.album.replace(/\(.*\)$/, "").trim(),
    });
  }

  return {
    artworkUrl: result?.artworkUrl100 ?? (await musicBrainzArtwork(props)),
    iTunesUrl: result?.trackViewUrl,
  };
}

async function iTunesSearch(
  { name, artist, album }: iTunesProps,
  retryCount: number = 3,
): Promise<iTunesSearchResponse | undefined> {
  // Asterisks tend to result in no songs found, and songs are usually able to be found without it
  const query = `${name} ${artist} ${album}`.replace("*", "");
  const params = new URLSearchParams({
    media: "music",
    entity: "song",
    term: query,
  });
  const url = `https://itunes.apple.com/search?${params}`;

  for (let i = 0; i < retryCount; i++) {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(
        "Failed to fetch from iTunes API: %s %s (Attempt %d/%d)",
        resp.statusText,
        url,
        i + 1,
        retryCount,
      );
      resp.body?.cancel();
      await sleep(200);
      continue;
    }
    return (await resp.json()) as iTunesSearchResponse;
  }
}

async function musicBrainzArtwork({
  name,
  artist,
  album,
}: iTunesProps): Promise<string | undefined> {
  const MB_EXCLUDED_NAMES = ["", "Various Artist"];

  const queryTerms = [];
  if (!MB_EXCLUDED_NAMES.every((elem) => artist.includes(elem))) {
    queryTerms.push(
      `artist:"${luceneEscape(removeParenthesesContent(artist))}"`,
    );
  }
  if (!MB_EXCLUDED_NAMES.every((elem) => album.includes(elem))) {
    queryTerms.push(`release:"${luceneEscape(album)}"`);
  } else {
    queryTerms.push(`recording:"${luceneEscape(name)}"`);
  }
  const query = queryTerms.join(" ");

  const params = new URLSearchParams({
    fmt: "json",
    limit: "10",
    query,
  });

  const resp = await fetch(`https://musicbrainz.org/ws/2/release?${params}`);
  const json = (await resp.json()) as MBReleaseLookupResponse;

  for (const release of json.releases) {
    const resp = await fetch(
      `https://coverartarchive.org/release/${release.id}/front`,
      { method: "HEAD" },
    );
    await resp.body?.cancel();
    if (resp.ok) {
      return resp.url;
    }
  }
}

function luceneEscape(term: string): string {
  return term.replace(/([+\-&|!(){}\[\]^"~*?:\\])/g, "\\$1");
}

function removeParenthesesContent(term: string): string {
  return term.replace(/\([^)]*\)/g, "").trim();
}
//#endregion

//#region TypeScript
type iTunesAppName = "iTunes" | "Music";

interface iTunesProps {
  id: number;
  persistentID: string;
  name: string;
  artist: string;
  album: string;
  year: number;
  duration?: number;
  playerPosition: number;
}

interface TrackExtras {
  artworkUrl?: string;
  iTunesUrl?: string;
}

interface iTunesSearchResponse {
  resultCount: number;
  results: iTunesSearchResult[];
}

interface iTunesSearchResult {
  trackName: string;
  collectionName: string;
  artworkUrl100: string;
  trackViewUrl: string;
}

interface MBReleaseLookupResponse {
  releases: MBRelease[];
}

interface MBRelease {
  id: string;
}
//#endregion
