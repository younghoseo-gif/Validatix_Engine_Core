import React from 'react';
import Link from 'next/link';
import {
  HomeIcon,
  VideoCameraIcon,
  FolderIcon,
  CogIcon,
  LogoutIcon,
  PlusCircleIcon,
  CreditCardIcon,
  UserIcon,
} from '@heroicons/react/outline'; // Assuming @heroicons/react is installed

// Dummy data for demonstration purposes
const recentVideos = [
  {
    id: 'vid_123',
    title: 'How AI is Changing the Creator Economy',
    thumbnail: 'https://img.youtube.com/vi/g_dF83T6VzU/hqdefault.jpg', // Placeholder thumbnail
    status: 'COMPLETED',
    languages: ['en', 'ja', 'es'],
    createdAt: '2023-10-26T10:00:00Z',
  },
  {
    id: 'vid_124',
    title: 'The Future of Content Creation with Generative AI',
    thumbnail: 'https://img.youtube.com/vi/qY_3m_iQc7k/hqdefault.jpg', // Placeholder thumbnail
    status: 'PROCESSING',
    progress: 75,
    languages: ['en', 'de'],
    createdAt: '2023-10-25T15:30:00Z',
  },
  {
    id: 'vid_125',
    title: 'Mastering YouTube SEO in 2024: A Comprehensive Guide',
    thumbnail: 'https://img.youtube.com/vi/Hj-g8K2_o3Q/hqdefault.jpg', // Placeholder thumbnail
    status: 'COMPLETED',
    languages: ['ko', 'en'],
    createdAt: '2023-10-24T08:45:00Z',
  },
];

const subscriptionInfo = {
  planName: 'Premium',
  videosThisMonth: 8,
  maxVideosPerMonth: 20,
  languagesAvailable: 10, // Total languages supported by platform
  maxSummaryLanguages: 5, // Languages per summary for this plan
  nextBillingDate: '2023-11-20',
};

const Dashboard: React.FC = () => {
  return (
    <div className="flex min-h-screen bg-gray-900 text-gray-100">
      {/* Sidebar - Global Navigation Bar */}
      <aside className="w-64 bg-gray-800 p-6 flex flex-col fixed h-full shadow-lg border-r border-gray-700">
        <div className="text-2xl font-bold text-blue-400 mb-8">The Architect</div>
        <nav className="flex-grow">
          <ul>
            <li className="mb-4">
              <Link
                href="/dashboard"
                className="flex items-center text-gray-300 hover:text-blue-400 hover:bg-gray-700 p-3 rounded-md transition-colors duration-200"
              >
                <HomeIcon className="h-5 w-5 mr-3" />
                Dashboard
              </Link>
            </li>
            <li className="mb-4">
              <Link
                href="/summarize/new"
                className="flex items-center text-gray-300 hover:text-blue-400 hover:bg-gray-700 p-3 rounded-md transition-colors duration-200"
              >
                <VideoCameraIcon className="h-5 w-5 mr-3" />
                New Video Summary
              </Link>
            </li>
            <li className="mb-4">
              <Link
                href="/my-summaries"
                className="flex items-center text-gray-300 hover:text-blue-400 hover:bg-gray-700 p-3 rounded-md transition-colors duration-200"
              >
                <FolderIcon className="h-5 w-5 mr-3" />
                My Summaries
              </Link>
            </li>
            <li className="mb-4">
              <Link
                href="/settings/profile"
                className="flex items-center text-gray-300 hover:text-blue-400 hover:bg-gray-700 p-3 rounded-md transition-colors duration-200"
              >
                <CogIcon className="h-5 w-5 mr-3" />
                Account Settings
              </Link>
            </li>
          </ul>
        </nav>
        {/* Logout is also part of global nav */}
        <div className="mt-8">
          <Link
            href="/logout"
            className="flex items-center text-gray-300 hover:text-blue-400 hover:bg-gray-700 p-3 rounded-md transition-colors duration-200"
          >
            <LogoutIcon className="h-5 w-5 mr-3" />
            Logout
          </Link>
        </div>
      </aside>

      {/* Main content area */}
      <main className="flex-1 ml-64 p-8">
        {/* Header */}
        <header className="flex justify-between items-center mb-10 pb-4 border-b border-gray-700">
          <h1 className="text-4xl font-extrabold text-gray-100">Dashboard</h1>
          <div className="flex items-center space-x-4">
            <span className="text-gray-300 text-lg">Welcome, Creator!</span>
            <div className="h-10 w-10 bg-blue-600 rounded-full flex items-center justify-center text-white font-semibold text-lg cursor-pointer">
              C {/* Placeholder for user initial or profile picture */}
            </div>
          </div>
        </header>

        {/* Dashboard Cards Section */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-10">
          {/* Quick Summary Start Card */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl border border-gray-700 hover:border-blue-500 transition-all duration-200">
            <PlusCircleIcon className="h-10 w-10 text-blue-400 mb-4" />
            <h2 className="text-2xl font-semibold mb-2 text-gray-100">Start New Summary</h2>
            <p className="text-gray-400 mb-6">
              Effortlessly summarize your YouTube videos across multiple languages.
            </p>
            <Link
              href="/summarize/new"
              className="inline-flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-md transition-colors duration-200 shadow-md"
            >
              <VideoCameraIcon className="h-5 w-5 mr-2" />
              Summarize a Video
            </Link>
          </div>

          {/* Subscription Info Card */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl border border-gray-700 hover:border-green-500 transition-all duration-200">
            <CreditCardIcon className="h-10 w-10 text-green-400 mb-4" />
            <h2 className="text-2xl font-semibold mb-2 text-gray-100">My Subscription</h2>
            <p className="text-gray-400 mb-4">Your current plan and usage details.</p>
            <ul className="text-gray-300 space-y-2">
              <li>
                <span className="font-medium">Plan:</span> {subscriptionInfo.planName}
              </li>
              <li>
                <span className="font-medium">Videos this month:</span>{' '}
                {subscriptionInfo.videosThisMonth} / {subscriptionInfo.maxVideosPerMonth}
              </li>
              <li>
                <span className="font-medium">Summary Languages:</span> Up to{' '}
                {subscriptionInfo.maxSummaryLanguages} per video
              </li>
              <li>
                <span className="font-medium">Next Billing:</span> {subscriptionInfo.nextBillingDate}
              </li>
            </ul>
            <Link
              href="/settings/subscription"
              className="mt-6 inline-block text-blue-400 hover:text-blue-300 transition-colors duration-200 text-sm"
            >
              Manage Subscription &rarr;
            </Link>
          </div>

          {/* Connect YouTube Card (as per PRD, a specific page for this exists, but a call to action on dashboard is good) */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl border border-gray-700 hover:border-purple-500 transition-all duration-200">
            <UserIcon className="h-10 w-10 text-purple-400 mb-4" />
            <h2 className="text-2xl font-semibold mb-2 text-gray-100">YouTube Channel</h2>
            <p className="text-gray-400 mb-6">
              Connect your YouTube channel to import videos directly.
            </p>
            <Link
              href="/settings/youtube-channels"
              className="inline-flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white font-medium py-3 px-6 rounded-md transition-colors duration-200 shadow-md"
            >
              Connect Channel
            </Link>
          </div>
        </section>

        {/* Recent Summaries Section - Data Table */}
        <section>
          <h2 className="text-3xl font-bold mb-6 text-gray-100">Recent Video Summaries</h2>
          <div className="bg-gray-800 rounded-lg shadow-xl overflow-hidden border border-gray-700">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-700">
                <tr>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    Video
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    Languages
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    Created
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-right text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {recentVideos.map((video) => (
                  <tr key={video.id} className="hover:bg-gray-700 transition-colors duration-150">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <img
                            className="h-10 w-10 rounded-md object-cover"
                            src={video.thumbnail}
                            alt={video.title}
                          />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-100">{video.title}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {video.status === 'COMPLETED' && (
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-700 text-green-100">
                          Completed
                        </span>
                      )}
                      {video.status === 'PROCESSING' && (
                        <div className="flex items-center">
                          <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-700 text-yellow-100">
                            Processing
                          </span>
                          <span className="ml-2 text-sm text-gray-400">({video.progress}%)</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                      {video.languages.map((lang) => (
                        <span
                          key={lang}
                          className="inline-block bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded-full mr-1 mb-1"
                        >
                          {lang.toUpperCase()}
                        </span>
                      ))}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                      {new Date(video.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <Link
                        href={`/my-summaries/${video.id}`}
                        className="text-blue-400 hover:text-blue-300 transition-colors duration-200"
                      >
                        View Results
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-center mt-8">
            <Link
              href="/my-summaries"
              className="text-blue-400 hover:text-blue-300 font-medium transition-colors duration-200"
            >
              View All Summaries &rarr;
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Dashboard;