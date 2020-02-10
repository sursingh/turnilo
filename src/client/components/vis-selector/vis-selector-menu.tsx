/*
 * Copyright 2015-2016 Imply Data, Inc.
 * Copyright 2017-2019 Allegro.pl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from "react";
import { VisualizationManifest } from "../../../common/models/visualization-manifest/visualization-manifest";
import { VisualizationSettings } from "../../../common/models/visualization-settings/visualization-settings";
import { Binary } from "../../../common/utils/functional/functional";
import { Fn } from "../../../common/utils/general/general";
import { ImmutableRecord } from "../../../common/utils/immutable-utils/immutable-utils";
import { MANIFESTS } from "../../../common/visualization-manifests";
import { STRINGS } from "../../config/constants";
import { settingsComponent } from "../../visualization-settings/settings-component";
import { Button } from "../button/button";
import { VisSelectorItem } from "./vis-selector-item";
import "./vis-selector-menu.scss";

export interface VisSelectorMenuProps {
  onSelect: Binary<VisualizationManifest, VisualizationSettings, void>;
  initialVisualization: VisualizationManifest;
  initialSettings: VisualizationSettings;
  onClose: Fn;
}

interface VisSelectorMenuState {
  visualization: VisualizationManifest;
  visualizationSettings: VisualizationSettings;
}

export class VisSelectorMenu extends React.Component<VisSelectorMenuProps, VisSelectorMenuState> {

  state: VisSelectorMenuState = {
    visualization: this.props.initialVisualization,
    visualizationSettings: this.props.initialSettings
  };

  save = () => {
    const { onSelect, onClose } = this.props;
    const { visualization, visualizationSettings } = this.state;
    onSelect(visualization, visualizationSettings);
    onClose();
  }

  close = () => this.props.onClose();

  changeVisualization = (visualization: VisualizationManifest) => this.setState({ visualization, visualizationSettings: visualization.visualizationSettings.defaults });
  changeSettings = (visualizationSettings: VisualizationSettings) => this.setState({ visualizationSettings });

  renderSettings() {
    const { visualization, visualizationSettings } = this.state;
    /*
     TODO:
      Right now we can't encode in type relationship between visualization and settings
      on Essence type. That's why we use "any" here. Downside is that we can pass somehow
      settings that are not valid for selected vis. This invariant is handled in code in
      Essence - after changing viz, we change settings using viz defaults or viz reader -
      bot of which return correct type.
      Invariants inside component are held - component and settings are declared using same
      type parameter. But still - this declaration is enforced locally - someone could write
      HeatmapComponent<LineChartSettings>.
      Idea is to encode settings and visualization behind one type parameter on Essence.
      Issues:
        Move manifest and mutbale settings into under one key
        How to keep type parameter attached to essence (on Clicker.state) when:
          Mutating something else (should keep type parameter)
          Chanigng viz (should change type parameter)
        Good solution would be to encode viz key and settings as union type with
        key as discriminant. Unfortunately, Immutable.Record would break union
        properties for typescript and will mash it into one super type.
    */
    const settings = visualizationSettings as ImmutableRecord<any>;
    const Settings = settingsComponent(visualization.name);

    if (!Settings) return null;
    return <div className="vis-settings">
      <div className="vis-settings-title">Settings</div>
      <Settings
        onChange={this.changeSettings}
        settings={settings} />
    </div>;
  }

  render() {
    const { visualization: selected } = this.state;

    return <div className="vis-selector-menu">
      <div className="vis-items">
        {MANIFESTS.map(visualization => <VisSelectorItem
          key={visualization.name}
          visualization={visualization}
          selected={visualization.name === selected.name}
          onClick={this.changeVisualization} />)}
      </div>
      {this.renderSettings()}
      <div className="ok-cancel-bar">
        <Button type="primary" title={STRINGS.ok} onClick={this.save} />
        <Button type="secondary" title={STRINGS.cancel} onClick={this.close} />
      </div>
    </div>;
  }
}