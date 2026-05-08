import * as vscode from 'vscode';
import { CodexBridgeExtensionApp } from './app/CodexBridgeExtensionApp';

const extensionApp = new CodexBridgeExtensionApp();

export function activate(context: vscode.ExtensionContext): void {
  extensionApp.activate(context);
}

export function deactivate(): void {
  extensionApp.deactivate();
}
