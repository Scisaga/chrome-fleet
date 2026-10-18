#!/bin/sh
set -eu
distribution="$1"
version="$2"
printf '%s' "$version" | awk 'BEGIN {ok=0} /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {ok=1} END {exit !ok}'
case "$distribution" in
  google)
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://dl.google.com/linux/linux_signing_key.pub -o /tmp/google-signing-key.asc
    key_directory="$(mktemp -d /tmp/fleet-google-key.XXXXXX)"
    chmod 0700 "$key_directory"
    # Active primary key published by https://www.google.com/linuxrepositories/.
    key_fingerprint=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
    gpg --homedir "$key_directory" --batch --import /tmp/google-signing-key.asc
    gpg --homedir "$key_directory" --batch --with-colons --fingerprint "$key_fingerprint" | awk -F: -v expected="$key_fingerprint" '$1 == "fpr" && $10 == expected {found=1} END {exit !found}'
    gpg --homedir "$key_directory" --batch --export "$key_fingerprint" > /usr/share/keyrings/google-linux.gpg
    rm -rf "$key_directory"
    printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list
    apt-get update
    # APT verifies the official signed repository metadata and referenced package hash.
    apt-get install -y --no-install-recommends "google-chrome-stable=${version}-1"
    rm -f /etc/apt/sources.list.d/google-chrome.list
    ;;
  cft)
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json -o /tmp/cft-versions.json
    url="$(jq -er --arg version "$version" '.versions[] | select(.version == $version) | .downloads.chrome[] | select(.platform == "linux64") | .url' /tmp/cft-versions.json)"
    case "$url" in "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip") ;; *) exit 2 ;; esac
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$url" -o /tmp/chrome.zip
    unzip -q /tmp/chrome.zip -d /opt
    ln -s /opt/chrome-linux64/chrome /usr/bin/google-chrome
    # CfT publishes this artifact through TLS; no fabricated official checksum/signature claim.
    ;;
  *) printf '%s\n' '不支持的 Chrome 分发' >&2; exit 2 ;;
esac
actual="$(/usr/bin/google-chrome --version)"
case "$actual" in *"$version"*) ;; *) printf '%s\n' '安装后的 Chrome 版本不匹配' >&2; exit 1 ;; esac
rm -rf /var/lib/apt/lists/* /tmp/google-signing-key.asc /tmp/cft-versions.json /tmp/chrome.zip
