/*
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient';
import {
  DEBUGGER_EXCEPTION_BREAKPOINTS,
  DEBUGGER_LINE_BREAKPOINTS
} from './constants';
import * as languageServer from './languageServer';
import { ApexTestOutlineProvider } from './views/testOutline';

export type ApexTestRequestInfo = {
  methodName: string;
  definingType: string;
  position: vscode.Position;
  file: string;
};

let languageClient: LanguageClient | undefined;
let languageClientReady = false;

export async function activate(context: vscode.ExtensionContext) {
  languageClient = await languageServer.createLanguageServer(context);
  if (languageClient) {
    const handle = languageClient.start();
    context.subscriptions.push(handle);

    languageClient.onReady().then(() => {
      languageClientReady = true;
    });
  }

  context.subscriptions.push(await registerTestView());

  const exportedApi = {
    getLineBreakpointInfo,
    getExceptionBreakpointInfo,
    isLanguageClientReady,
    getApexTests
  };
  return exportedApi;
}

async function getLineBreakpointInfo(): Promise<{}> {
  let response = {};
  if (languageClient) {
    response = await languageClient.sendRequest(DEBUGGER_LINE_BREAKPOINTS);
  }
  return Promise.resolve(response);
}

export async function getApexTests(): Promise<ApexTestRequestInfo[]> {
  let response = new Array<ApexTestRequestInfo>();
  if (languageClient) {
    response = (await languageClient.sendRequest(
      'test/getTestMethods'
    )) as ApexTestRequestInfo[];
  }
  return Promise.resolve(response);
}

async function getExceptionBreakpointInfo(): Promise<{}> {
  let response = {};
  if (languageClient) {
    response = await languageClient.sendRequest(DEBUGGER_EXCEPTION_BREAKPOINTS);
  }
  return Promise.resolve(response);
}

async function registerTestView(): Promise<vscode.Disposable> {
  // Test View
  const rootPath = vscode.workspace.workspaceFolders![0].name;
  let apexClasses: ApexTestRequestInfo[] | null = null;
  if (isLanguageClientReady()) {
    apexClasses = await getApexTests();
  }

  const apexClassesDocs = await getApexClassFiles();
  const testOutlineProvider = new ApexTestOutlineProvider(
    rootPath,
    apexClassesDocs,
    apexClasses
  );

  const testViewItems = new Array<vscode.Disposable>();

  const testProvider = vscode.window.registerTreeDataProvider(
    'sfdx.force.test.view',
    testOutlineProvider
  );
  testViewItems.push(testProvider);

  // Run Test Button on Test View command
  testViewItems.push(
    vscode.commands.registerCommand('sfdx.force.test.view.run', () =>
      testOutlineProvider.runApexTests()
    )
  );
  // Show Error Message command
  testViewItems.push(
    vscode.commands.registerCommand('sfdx.force.test.view.showError', test =>
      testOutlineProvider.showErrorMessage(test)
    )
  );
  // Run Single Test command
  testViewItems.push(
    vscode.commands.registerCommand(
      'sfdx.force.test.view.runSingleTest',
      test => testOutlineProvider.runSingleTest(test)
    )
  );
  // Refresh Test View command
  testViewItems.push(
    vscode.commands.registerCommand('sfdx.force.test.view.refresh', () =>
      testOutlineProvider.refresh()
    )
  );

  return vscode.Disposable.from(...testViewItems);
}

export async function getApexClassFiles(): Promise<vscode.Uri[]> {
  const jsonProject = (await vscode.workspace.findFiles('**/sfdx-project.json'))[0];
  const innerText = fs.readFileSync(jsonProject.path);
  const jsonObject = JSON.parse(innerText.toString());
  const packageDirectories = jsonObject.packageDirectories || jsonObject.PackageDirectories;
  const allClasses = new Array<vscode.Uri>();
  for (const packageDirectory of packageDirectories) {
    const pattern = path.join(packageDirectory.path, '**/*.cls');
    const apexClassFiles = await vscode.workspace.findFiles(pattern);
    allClasses.push(...apexClassFiles);
  }
  return allClasses;
}

export function isLanguageClientReady(): boolean {
  return languageClientReady;
}

// tslint:disable-next-line:no-empty
export function deactivate() { }
