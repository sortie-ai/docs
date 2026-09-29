---
title: "Kiro CLI in Sortie"
description: "Sortie runs Kiro CLI in ACP mode. Find the reference for launching it, and the guide for connecting it or updating an older workflow."
author: Sortie AI
date: 2026-05-29
weight: 140
url: /reference/adapter-kiro/
sidebar:
  exclude: true
excludeSearch: true
---
Sortie runs [Kiro CLI](https://kiro.dev/docs/cli/) in ACP mode, over the `agent-client-protocol` agent kind. There is no separate Kiro adapter.

- [Kiro CLI (Agent Client Protocol)](/reference/agent-client-protocol-kiro/) describes the launch command, the credentials, how Sortie's tools reach Kiro CLI, and its limitations.
- [How to run Kiro CLI in ACP mode](/guides/run-kiro-cli-in-acp-mode/) connects Kiro CLI to Sortie and converts a workflow that still names `kind: kiro`.

A workflow that still names `kind: kiro` keeps loading for now through a temporary automatic conversion. The guide covers what to change to end it.
