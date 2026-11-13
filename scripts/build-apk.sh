#!/bin/sh
# Build luci-app-fwdesktop with the official OpenWrt SDK.
# Usage: scripts/build-apk.sh [workdir]   -> prints path of the built .apk
# Used by the release workflow; works the same on a local Linux box.
set -eu

OPENWRT_VERSION=${OPENWRT_VERSION:-25.12.6}
SDK_TARGET=${SDK_TARGET:-x86/64}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${1:-$REPO/.sdk}
BASE=https://downloads.openwrt.org/releases/$OPENWRT_VERSION/targets/$SDK_TARGET

mkdir -p "$WORK"
cd "$WORK"

SDK_FILE=$(curl -fsSL "$BASE/" | grep -o 'openwrt-sdk-[^"<]*\.tar\.zst' | sort -u | head -n1)
[ -n "$SDK_FILE" ] || { echo "SDK not found at $BASE" >&2; exit 1; }
SDK_DIR=${SDK_FILE%.tar.zst}

if [ ! -d "$SDK_DIR" ]; then
	[ -f "$SDK_FILE" ] || curl -fsSL -o "$SDK_FILE" "$BASE/$SDK_FILE"
	tar --zstd -xf "$SDK_FILE"
fi

cd "$SDK_DIR"
rm -rf package/luci-app-fwdesktop
cp -r "$REPO/luci-app-fwdesktop" package/

./scripts/feeds update base packages luci >/dev/null
./scripts/feeds install -p luci luci-base csstidy luasrcdiet >/dev/null
./scripts/feeds install lua >/dev/null 2>&1 || true

make defconfig >/dev/null 2>&1
echo 'CONFIG_PACKAGE_luci-app-fwdesktop=m' >> .config
make defconfig >/dev/null 2>&1

make package/luci-app-fwdesktop/compile -j"$(nproc)" V=s >build.log 2>&1 || { tail -50 build.log >&2; exit 1; }

APK=$(find bin -name 'luci-app-fwdesktop-*.apk' | head -n1)
[ -n "$APK" ] || { echo "no apk built" >&2; tail -50 build.log >&2; exit 1; }
if find build_dir -path '*luci-app-fwdesktop*' -name '*.js.o' | grep -q .; then
	echo "jsmin failed on a file (stray .js.o), refusing to ship" >&2
	exit 1
fi
echo "$PWD/$APK"
