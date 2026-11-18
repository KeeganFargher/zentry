/** Exact operator-approved origins. Loopback HTTP is reserved for the local fixture. */
export function approvedUptimeTarget(target: URL, approvedOrigins: string): boolean {
  if (
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    target.search !== ""
  ) {
    return false;
  }

  return approvedOrigins.split(",").includes(target.origin);
}

export function productionUptimeTarget(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    target.port === "" &&
    /^(?:[a-z0-9-]+\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(target.hostname)
  );
}
