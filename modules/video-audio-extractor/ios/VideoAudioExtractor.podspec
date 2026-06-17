require 'json'
pkg = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'VideoAudioExtractor'
  s.version        = pkg['version']
  s.summary        = pkg['description']
  s.license        = 'MIT'
  s.author         = 'StringAI'
  s.homepage       = 'https://github.com/stringai'
  s.platform       = :ios, '15.1'
  s.source         = { :path => '.' }
  s.source_files   = '*.swift'
  s.dependency 'ExpoModulesCore'
end
