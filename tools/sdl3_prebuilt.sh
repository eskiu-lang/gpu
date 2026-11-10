#!/bin/sh
# Builds the SDL3 archive that eskiu.toml's [native.SDL3] names for one platform:
#
#     tools/sdl3_prebuilt.sh PLATFORM OUT_DIR
#
# PLATFORM is macos-arm64, macos-x86_64, linux-x86_64, linux-arm64 or windows-x86_64. The
# archive, OUT_DIR/sdl3-VERSION-PLATFORM.tar.gz, holds lib/ (the shared library, plus the
# import library on Windows), include/SDL3, LICENSE.txt (SDL's zlib license) and
# README.txt; the script prints its eskiu.toml line. macOS and Linux build SDL's release
# source with CMake (Linux on the runner's glibc, with X11, Wayland, ALSA, PulseAudio and
# PipeWire loaded at run time, so the development packages must be installed); Windows
# repackages SDL's own MinGW build. Both downloads are checked against their SHA-256.
#
# .github/workflows/sdl3.yml runs it for every platform and publishes the archives.
set -eu

SDL_VERSION=3.4.18
SDL_SOURCE_SHA256=9c75cf16330322c217dedd2e0609f1124f1b54b8633e763467b4684d0f4334a3
SDL_MINGW_SHA256=049b9dd711e3fb3f8d84feb998dfec54a75e17cf539c4a80ff4d058d839771cf
RELEASE_URL=${SDL3_RELEASE_URL:-https://github.com/eskiu-lang/gpu/releases/download/sdl3-$SDL_VERSION}

if [ $# -ne 2 ]; then
    echo "usage: $0 PLATFORM OUT_DIR" >&2
    exit 2
fi
platform=$1
mkdir -p "$2"
out=$(cd "$2" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage=$work/stage
mkdir -p "$stage/lib"

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
    curl -fsSL --retry 2 -o "$work/$1" "https://github.com/libsdl-org/SDL/releases/download/release-$SDL_VERSION/$1"
    got=$(sha256 "$work/$1")
    if [ "$got" != "$2" ]; then
        echo "$1 has sha256 $got, not $2" >&2
        exit 1
    fi
    tar -xzf "$work/$1" -C "$work"
}

build() {
    fetch "SDL3-$SDL_VERSION.tar.gz" "$SDL_SOURCE_SHA256"
    cmake -S "$work/SDL3-$SDL_VERSION" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$work/install" -DSDL_SHARED=ON -DSDL_STATIC=OFF \
        -DSDL_TEST_LIBRARY=OFF -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF "$@"
    cmake --build "$work/build"
    cmake --install "$work/build"
    cp -R "$work/install/include" "$stage/include"
    cp "$work/SDL3-$SDL_VERSION/LICENSE.txt" "$stage/LICENSE.txt"
}

case "$platform" in
    macos-arm64 | macos-x86_64)
        arch=${platform#macos-}
        build -DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
        # libSDL3.dylib links; libSDL3.0.dylib is the install name programs load.
        cp -P "$work/install/lib/"libSDL3*.dylib "$stage/lib/"
        ;;
    linux-x86_64 | linux-arm64)
        build -DCMAKE_INSTALL_LIBDIR=lib
        cp -P "$work/install/lib/"libSDL3.so* "$stage/lib/"
        ;;
    windows-x86_64)
        fetch "SDL3-devel-$SDL_VERSION-mingw.tar.gz" "$SDL_MINGW_SHA256"
        mingw=$work/SDL3-$SDL_VERSION/x86_64-w64-mingw32
        # The import library links (GNU ld and lld); the DLL is copied next to programs.
        cp "$mingw/lib/libSDL3.dll.a" "$mingw/bin/SDL3.dll" "$stage/lib/"
        cp -R "$mingw/include" "$stage/include"
        cp "$work/SDL3-$SDL_VERSION/LICENSE.txt" "$stage/LICENSE.txt"
        ;;
    *)
        echo "unknown platform $platform" >&2
        exit 2
        ;;
esac

cat > "$stage/README.txt" <<EOF
SDL $SDL_VERSION for $platform, as eskiu-lang/gpu's eskiu.toml names it ([native.SDL3]).

Source: https://github.com/libsdl-org/SDL/releases/tag/release-$SDL_VERSION
Built by tools/sdl3_prebuilt.sh in https://github.com/eskiu-lang/gpu (Windows: SDL's own
MinGW build, repackaged). SDL is under the zlib license, in LICENSE.txt.
EOF

name=sdl3-$SDL_VERSION-$platform.tar.gz
(cd "$stage" && COPYFILE_DISABLE=1 tar -czf "$out/$name" lib include LICENSE.txt README.txt)
echo "$platform = { url = \"$RELEASE_URL/$name\", sha256 = \"$(sha256 "$out/$name")\" }"
