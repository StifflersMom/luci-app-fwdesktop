# This is free software, licensed under the Apache License, Version 2.0.

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Object based firewall desktop (fw4)
LUCI_DESCRIPTION:=Visual, object based firewall editor. Define hosts, networks \
	and services as objects, draw connections between them and let the app \
	generate fw4 rules, port forwards and NAT.
LUCI_DEPENDS:=+luci-base +luci-app-firewall +firewall4
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=11

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Klaus <StifflersMom@users.noreply.github.com>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
