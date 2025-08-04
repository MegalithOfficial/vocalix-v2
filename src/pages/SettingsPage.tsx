import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Volume2, Shield, Twitch, Volume, Settings2, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSettingsState } from '../hooks/useSettingsState';
import { SettingsTab } from '../types/settings';

import TwitchSettingsTab from '../components/settings/TwitchSettingsTab';
import AudioSettingsTab from '../components/settings/AudioSettingsTab';
import TTSSettingsTab from '../components/settings/TTSSettingsTab';
import PythonEnvironmentTab from '../components/settings/PythonEnvironmentTab';
import SecuritySettingsTab from '../components/settings/SecuritySettingsTab';
import LogsSettingsTab from '../components/settings/LogsSettingsTab';

const SettingsPage = () => {
    const [activeTab, setActiveTab] = useState<SettingsTab>('twitch');
    const settingsState = useSettingsState(activeTab);
    const { onlyClientMode } = settingsState;

    const tabs = [
        { id: 'twitch' as SettingsTab, label: 'Twitch Integration', icon: Twitch, color: 'purple', serverOnly: true },
        { id: 'audio' as SettingsTab, label: 'Audio Settings', icon: Volume2, color: 'blue', serverOnly: false },
        { id: 'tts' as SettingsTab, label: 'Text to Speech', icon: Volume, color: 'orange', serverOnly: true },
        { id: 'python-env' as SettingsTab, label: 'Python Environment', icon: Settings2, color: 'yellow', serverOnly: true },
        { id: 'security' as SettingsTab, label: 'Security & Privacy', icon: Shield, color: 'green', serverOnly: false },
        { id: 'logs' as SettingsTab, label: 'Application Logs', icon: FileText, color: 'red', serverOnly: false },
    ];

    const visibleTabs = useMemo(() => {
        return tabs.filter(t => !(onlyClientMode && t.serverOnly));
    }, [onlyClientMode]);

    useEffect(() => {
        const stillVisible = visibleTabs.some(t => t.id === activeTab);
        if (!stillVisible && visibleTabs.length > 0) {
            setActiveTab(visibleTabs[0].id);
        }
    }, [onlyClientMode, activeTab, visibleTabs]);

    const renderTabContent = () => {
        switch (activeTab) {
            case 'twitch':
                return <TwitchSettingsTab settingsState={settingsState} />;
            case 'audio':
                return <AudioSettingsTab settingsState={settingsState} />;
            case 'tts':
                return <TTSSettingsTab settingsState={settingsState} />;
            case 'python-env':
                return <PythonEnvironmentTab settingsState={settingsState} />;
            case 'security':
                return <SecuritySettingsTab settingsState={settingsState} />;
            case 'logs':
                return <LogsSettingsTab />;
            default:
                return null;
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex">
            {/* Sidebar */}
            <div className="w-80 bg-gray-900/50 border-r border-gray-800 flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-gray-800">
                    <Link to="/">
                        <motion.div
                            whileHover={{ x: -3 }}
                            className="flex items-center text-gray-300 hover:text-white transition-colors cursor-pointer mb-4"
                        >
                            <ArrowLeft className="w-5 h-5 mr-2" />
                            <span className="font-medium">Back to Home</span>
                        </motion.div>
                    </Link>

                    <div className="flex items-center">
                        <div className="w-3 h-3 bg-purple-400 rounded-full mr-3"></div>
                        <h1 className="text-xl font-semibold text-white">Settings</h1>
                    </div>
                </div>

                {/* Tab navigation */}
                <div className="flex-1 p-4">
                    <div className="space-y-2">
                        {visibleTabs.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeTab === tab.id;
                            const colorClasses = {
                                purple: isActive ? 'bg-purple-600/20 text-purple-400 border-purple-500/30' : 'hover:bg-purple-500/10 hover:text-purple-400',
                                blue: isActive ? 'bg-blue-600/20 text-blue-400 border-blue-500/30' : 'hover:bg-blue-500/10 hover:text-blue-400',
                                green: isActive ? 'bg-green-600/20 text-green-400 border-green-500/30' : 'hover:bg-green-500/10 hover:text-green-400',
                                pink: isActive ? 'bg-pink-600/20 text-pink-400 border-pink-500/30' : 'hover:bg-pink-500/10 hover:text-pink-400',
                                orange: isActive ? 'bg-orange-600/20 text-orange-400 border-orange-500/30' : 'hover:bg-orange-500/10 hover:text-orange-400',
                                yellow: isActive ? 'bg-yellow-600/20 text-yellow-400 border-yellow-500/30' : 'hover:bg-yellow-500/10 hover:text-yellow-400',
                                red: isActive ? 'bg-red-600/20 text-red-400 border-red-500/30' : 'hover:bg-red-500/10 hover:text-red-400',
                            };

                            return (
                                <motion.button
                                    key={tab.id}
                                    whileHover={{ x: 4 }}
                                    whileTap={{ scale: 0.98 }}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`w-full flex items-center px-4 py-3 rounded-xl border transition-all text-left ${isActive
                                            ? `${colorClasses[tab.color as keyof typeof colorClasses]} border`
                                            : `text-gray-400 border-transparent ${colorClasses[tab.color as keyof typeof colorClasses]}`
                                        }`}
                                >
                                    <Icon className="w-5 h-5 mr-3" />
                                    <span className="font-medium">{tab.label}</span>
                                </motion.button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Main content area */}
            <div className="flex-1 overflow-auto">
                <div className="p-8">
                    <div className="max-w-4xl mx-auto">
                        {renderTabContent()}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
