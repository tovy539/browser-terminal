import os from "os";

export function localIpv4Addresses() {
  const ips = new Set();
  for (const nets of Object.values(os.networkInterfaces())) {
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === "IPv4" && !net.internal) {
        ips.add(net.address);
      }
    }
  }
  return [...ips].sort();
}
