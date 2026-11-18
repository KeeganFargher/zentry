// Signing phones in to the mobile app, and signing them out. DESIGN.md §19.
// The QR code holds a ten-minute, single-use code; the app trades it for its
// own token. While the code is on screen the device list refreshes, so the
// new phone appears here the moment it signs in.

import type { ApiDevice, ApiPairing } from "@contract";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { encode } from "uqr";

import { Notice } from "~/components/basics";
import { api, ApiFailure } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { useResource } from "~/lib/resource";
import { toast } from "~/lib/toast";

const REFRESH_WHILE_PAIRING = 3000;

/** The code as one path: a unit square per dark module. */
function QrCode({ text }: { text: string }): JSX.Element {
  const { size, data } = encode(text, { border: 2 });

  const modules = data.flatMap((row, y) =>
    row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])),
  );

  return (
    <svg
      className="qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code to sign in to the Zentry app"
    >
      <rect width={size} height={size} className="qr-light" />
      <path d={modules.join("")} className="qr-dark" />
    </svg>
  );
}

type PairingProps = { pairing: ApiPairing; onDone: () => void; onTick: () => void };

/**
 * Shown only while a code is live. It ticks each second for the countdown (the
 * minute clock would leave it a minute stale) and refreshes the device list
 * every few seconds, so the phone shows up as soon as it signs in.
 */
function Pairing({ pairing, onDone, onTick }: PairingProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const countdown = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(onTick, REFRESH_WHILE_PAIRING);

    return () => {
      clearInterval(countdown);
      clearInterval(refresh);
    };
  }, [onTick]);

  const left = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));

  if (left === 0) {
    return (
      <div className="pairing">
        <p className="muted">That code has expired.</p>
        <button type="button" onClick={onDone}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="pairing">
      <QrCode text={pairing.link} />
      <div>
        <p>
          Open the Zentry app and scan this code. It works once, for the next{" "}
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
        </p>
        <p className="muted">
          Anyone who scans it signs in as you, so do not share a screenshot of it.
        </p>
        <div className="pairing-actions">
          {/* For a phone that cannot scan, such as an emulator: paste it into the app. */}
          <button
            type="button"
            onClick={() => {
              navigator.clipboard
                .writeText(pairing.link)
                .then(() => toast("Sign-in link copied"))
                .catch((cause: unknown) =>
                  toast(cause instanceof Error ? cause.message : "Could not copy the link"),
                );
            }}
          >
            Copy link
          </button>
          <button type="button" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

type DeviceRowProps = { device: ApiDevice; now: number; onChanged: () => void };

function DeviceRow({ device, now, onChanged }: DeviceRowProps): JSX.Element {
  const signOut = async (): Promise<void> => {
    if (!window.confirm(`Sign ${device.name} out? It stops getting notifications at once.`)) {
      return;
    }

    try {
      await api.removeDevice(device.id);
      toast(`${device.name} signed out`);
      onChanged();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not sign the phone out");
    }
  };

  return (
    <div className="dsn">
      <strong className="device-name">{device.name}</strong>
      <span className="muted device-facts">
        Signed in {timeAgo(device.createdAt, now)}, last used {timeAgo(device.lastSeenAt, now)}
        {device.push ? " · push on" : " · push off"}
      </span>
      <button type="button" className="danger" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

export function MobileSettings(): JSX.Element {
  const devices = useResource("devices", api.devices);
  const [pairing, setPairing] = useState<ApiPairing | null>(null);
  const now = useNow();
  const { reload } = devices;

  const start = async (): Promise<void> => {
    try {
      setPairing(await api.createPairing());
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not make a sign-in code");
    }
  };

  const list = devices.data?.devices ?? null;

  return (
    <>
      <header className="topbar">
        <h1>Mobile app</h1>
      </header>
      <div className="content narrow">
        <section className="panel padded">
          <h2>Sign in on a phone</h2>
          <p className="muted">
            The Android app shows your issues and sends push notifications. Choose which ones under
            Notifications, Push.
          </p>
          {pairing === null ? (
            <button type="button" className="primary" onClick={() => void start()}>
              Show sign-in code
            </button>
          ) : (
            <Pairing pairing={pairing} onDone={() => setPairing(null)} onTick={reload} />
          )}
        </section>
        <section className="panel padded">
          <h2>Signed-in phones</h2>
          {list === null ? (
            <Notice loading={devices.loading} error={devices.error} />
          ) : list.length === 0 ? (
            <p className="muted">No phone is signed in.</p>
          ) : (
            list.map((device) => (
              <DeviceRow key={device.id} device={device} now={now} onChanged={reload} />
            ))
          )}
        </section>
      </div>
    </>
  );
}
